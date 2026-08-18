import { AGENT_RUNTIME_LABELS, type AgentRuntime } from '@hezo/shared';
import type { MasterKeyManager } from '../../crypto/master-key';
import type { Db } from '../../db/database';
import { broadcastConnectorRowChange } from '../../lib/broadcast';
import { logger } from '../../logger';
import type { ConnectorRunRejection } from '../egress/proxy';
import type { WebSocketManager } from '../ws';
import type { MethodDiscoveryResult } from './method-discovery';

const log = logger.child('connectors');

/**
 * What a run's connector refusal is turned into, in two phases so the fact the
 * run saw is in its log even when the run ends before Hezo's re-check does.
 *
 * Phase one ({@link describeConnectorRejection}) is pure: the connector, the
 * status, and whether the run sent a credential - enough on its own to name a
 * runtime that drops a configured header. Phase two
 * ({@link recheckRejectedConnector}) has Hezo probe the connector itself through
 * the one sanctioned writer of connector health, so a dead credential lights the
 * banner and "Needs reconnect", a server that newly demands auth is withheld
 * from later runs, and a fine credential is confirmed fine - then says which.
 */

export interface RecheckDeps {
	db: Db;
	masterKeyManager: MasterKeyManager;
	/** Absent in tests that do not care about the live refresh. */
	wsManager?: WebSocketManager;
}

export interface RecheckContext {
	/** For the server log only. */
	runId?: string;
	label: string;
	/** The project team's room, which is what the Connectors page subscribes to. */
	teamId: string;
	projectId: string | null;
}

/** Where a caller puts the two sentences: a run's log, a chat thread. */
export interface RejectionSink {
	observed(line: string): void | Promise<void>;
	verdict(line: string): void | Promise<void>;
}

/**
 * The whole report, for a caller that only decides where the sentences go: the
 * observed fact first, then Hezo's re-check and its verdict. Rejects only if a
 * sink does; the re-check itself never does.
 */
export async function reportConnectorRunRejection(
	deps: RecheckDeps,
	event: ConnectorRunRejection,
	ctx: RecheckContext & { runtime: AgentRuntime },
	sink: RejectionSink,
): Promise<void> {
	await sink.observed(describeConnectorRejection(event, ctx.runtime));
	await sink.verdict(await recheckRejectedConnector(deps, event, ctx));
}

/** The observed refusal, as a sentence: what the run saw, and what Hezo is doing about it. */
export function describeConnectorRejection(
	event: ConnectorRunRejection,
	runtime: AgentRuntime,
): string {
	const name = `connector "${event.connectorName}"`;
	switch (event.kind) {
		case 'substitution_failed':
			return (
				`Hezo could not substitute the credential for ${name} (${event.reason})` +
				`${event.detail ? `: ${event.detail}` : ''} - the request went out without it. ` +
				'Hezo is re-checking the connector.'
			);
		case 'upstream_unreachable':
			return `${name} was unreachable from this run (${event.reason}). Hezo is re-checking it.`;
		case 'upstream_rejected': {
			const status = `HTTP ${event.status}`;
			if (!event.credentialed) {
				return `${name} refused this run's request (${status}) - it now requires a credential. Hezo is re-checking it.`;
			}
			if (event.credentialSent) {
				return `${name} refused this run's request (${status}) although its credential was sent. Hezo is re-checking it.`;
			}
			return (
				`${name} refused this run's request (${status}): the request carried no credential ` +
				`although one is configured, so the ${AGENT_RUNTIME_LABELS[runtime]} runtime is not sending it. ` +
				'Hezo is re-checking the connector itself.'
			);
		}
	}
}

/**
 * The shapes a re-check can come back in, collapsed from the probe's own
 * result so the notice table below has one row per meaning.
 */
type RecheckVerdict =
	| 'ok'
	| 'auth_failed'
	| 'auth_unverifiable'
	| 'unreachable'
	| 'locked'
	| 'not_connected'
	| 'gone';

function classifyRecheck(result: MethodDiscoveryResult): RecheckVerdict {
	if (result.ok) return 'ok';
	switch (result.reason) {
		case 'auth_failed':
			return 'auth_failed';
		case 'auth_unverifiable':
			return 'auth_unverifiable';
		case 'locked':
			return 'locked';
		case 'not_connected':
			return 'not_connected';
		case 'not_found':
		case 'unsupported_kind':
			return 'gone';
		default:
			// The handshake completed and only the catalog was refused: the server
			// is reachable and speaks MCP, which is what a run needs.
			return result.phase === 'catalog' ? 'ok' : 'unreachable';
	}
}

const CONNECTORS_PAGE = "the project's Connectors page";

/** The re-check's verdict, as the sentence a run's log or a chat thread reads. */
function describeRecheck(event: ConnectorRunRejection, verdict: RecheckVerdict): string {
	const name = `connector "${event.connectorName}"`;
	switch (verdict) {
		case 'locked':
			return `${name}: Hezo could not re-check it while the vault is locked - unlock and press Refresh on the connector.`;
		case 'not_connected':
			return `${name}: Hezo could not re-check it because it is not connected - connect it on ${CONNECTORS_PAGE}.`;
		case 'gone':
			return `${name}: Hezo could not re-check it - the connector no longer exists as a hosted MCP server.`;
		default:
			break;
	}
	if (event.kind === 'upstream_unreachable') {
		if (verdict === 'unreachable') {
			return (
				`${name}: Hezo's re-check could not reach it either` +
				(event.credentialed ? '.' : ', so it stays out of later runs until a check succeeds.')
			);
		}
		return `${name}: Hezo's own re-check reached it, so the failure may be transient or specific to the run's route.`;
	}
	if (event.kind === 'substitution_failed') {
		switch (verdict) {
			case 'auth_failed':
				return `${name}: Hezo's re-check also found the credential is no longer accepted - reconnect it on ${CONNECTORS_PAGE}.`;
			case 'unreachable':
				return `${name}: Hezo's re-check could not reach it either.`;
			default:
				return `${name}: Hezo's re-check reached it, so the request failed only because its credential could not be substituted - check the secret's allowed hosts.`;
		}
	}
	// upstream_rejected
	if (!event.credentialed) {
		return verdict === 'auth_failed'
			? `${name}: Hezo's re-check confirms the server now requires a credential; it is held back from later runs until one is connected on ${CONNECTORS_PAGE}.`
			: `${name}: Hezo's re-check succeeded, so the refusal did not reproduce.`;
	}
	if (event.credentialSent) {
		switch (verdict) {
			case 'auth_failed':
				return `${name}: Hezo's re-check confirms the credential is no longer accepted - reconnect it on ${CONNECTORS_PAGE}.`;
			case 'auth_unverifiable':
				return `${name}: its credential is a placeholder header Hezo substitutes at request time and cannot re-check from here - verify the secret's value and allowed hosts.`;
			case 'unreachable':
				return `${name}: Hezo's re-check could not reach it, so the refusal could not be confirmed.`;
			default:
				return `${name}: Hezo's re-check with the same credential succeeded - the server may need a scope this credential lacks; reconnect to grant it.`;
		}
	}
	switch (verdict) {
		case 'auth_failed':
			return `${name}: the runtime is not sending its credential, and Hezo's re-check found that credential is no longer accepted either - reconnect it on ${CONNECTORS_PAGE}.`;
		case 'auth_unverifiable':
			return `${name}: its credential is a placeholder header Hezo cannot re-check from here; the run's request did not carry it.`;
		case 'unreachable':
			return `${name}: Hezo's re-check could not reach it, so the credential could not be confirmed.`;
		default:
			return `${name}: Hezo's re-check with the configured credential succeeded - the credential is fine and the runtime is not sending it (a Hezo defect).`;
	}
}

/**
 * Whether the observed shape is Hezo's own doing rather than the connector's: a
 * credentialed connector whose request carried no credential. That is a runtime
 * adapter dropping a configured header, and it must never pass quietly.
 */
export function isRuntimeDroppedCredential(event: ConnectorRunRejection): boolean {
	return event.kind === 'upstream_rejected' && event.credentialed && !event.credentialSent;
}

/**
 * Re-check the connector with Hezo's own probe and say what it found. The probe
 * is the sanctioned writer of `auth_error` / `probe_error`, so the connector
 * card, the project banner and the run gate follow from the same call; the
 * broadcast is what makes an open Connectors page notice. Never rejects.
 */
export async function recheckRejectedConnector(
	deps: RecheckDeps,
	event: ConnectorRunRejection,
	ctx: RecheckContext,
): Promise<string> {
	if (isRuntimeDroppedCredential(event)) {
		log.error('agent run reached a credentialed connector without its credential', {
			run: ctx.runId ?? ctx.label,
			connector: event.connectorName,
			status: event.status,
		});
	}
	// Loaded on first use, as the routes and the health sweep do, so the run
	// pipeline does not import the MCP client SDK on the way to a container.
	const { discoverConnectorMethods } = await import('./method-discovery');
	let result: MethodDiscoveryResult;
	try {
		result = await discoverConnectorMethods(deps, event.connectorId, 'run');
	} catch (e) {
		result = {
			ok: false,
			reason: 'probe_failed',
			detail: (e as Error).message,
			phase: 'handshake',
		};
	}
	const verdict = classifyRecheck(result);
	if (verdict !== 'gone') {
		try {
			broadcastConnectorRowChange(
				deps.wsManager,
				{ teamId: ctx.teamId, projectId: ctx.projectId },
				'UPDATE',
				{ id: event.connectorId },
			);
		} catch (e) {
			log.warn('connector re-check broadcast failed', { error: (e as Error).message });
		}
	}
	return describeRecheck(event, verdict);
}
