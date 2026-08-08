/**
 * The one place a connector's state is derived from its stored columns.
 *
 * This ladder used to exist three times - in the server's connector lifecycle,
 * inline in the `list_connectors` MCP tool, and again in the web's connector
 * hook - and the copies were not equivalent, which is how a real defect hid in
 * plain sight: a connector whose OAuth grant had expired kept reporting
 * `active` to the operator, to agents, and to the connect-required card, so the
 * only signal anything was wrong was a raw error string printed under a green
 * "Connected" chip.
 *
 * The cause was `auth_error` being overloaded. It means both "the first connect
 * attempt errored" and "a token that used to work has stopped refreshing", and
 * the old ladder could only express the first (`auth_error && !activated_at`),
 * so a working-to-broken regression was definitionally invisible. `Degraded`
 * names the second case, and `activated_at` - the field that distinguishes them
 * - is what it is derived from, so no extra column is needed.
 *
 * Server and web both derive status, so this lives in `@hezo/shared` and there
 * is exactly one implementation.
 *
 * Known limitation, deliberate: an API-key connector can never become
 * `Degraded`. The only writer of `auth_error` keys on `oauth_connection_id`, so
 * a pasted key the provider later revoked leaves the row reporting `Active`
 * forever. That is the same bug class for the other credential type and wants
 * its own fix - do not "solve" it by loosening the ladder here.
 */

import { ConnectorTransport } from '../types/common.js';

export const ConnectorStatus = {
	/** Created, but the human has not completed auth yet. */
	Pending: 'pending',
	/** Usable: credentials stored and stamped. */
	Active: 'active',
	/** Was active; its stored credential no longer works and a human must reconnect. */
	Degraded: 'degraded',
	/** Never became active - the connect attempt itself errored. */
	Failed: 'failed',
	/** A human explicitly disconnected it. */
	Revoked: 'revoked',
} as const;
export type ConnectorStatus = (typeof ConnectorStatus)[keyof typeof ConnectorStatus];

/**
 * Only `list_connectors` needs this. "This row has no OAuth story at all" is a
 * fact about the MCP response shape, not a state a connector can be in, so it
 * is kept out of `ConnectorStatus` and the web never has to handle it.
 */
export const CONNECTOR_OAUTH_STATUS_NONE = 'none';
export type ConnectorOAuthStatus = ConnectorStatus | typeof CONNECTOR_OAUTH_STATUS_NONE;

/**
 * Structural on purpose - the snake_case column names, so the server's row type
 * and the web's `Connector` both satisfy it with no mapping. `kind` is `string`
 * rather than `ConnectorTransport` because the server row carries it untyped.
 */
export interface ConnectorStatusRow {
	kind: string;
	oauth_connection_id: string | null;
	api_key_secret_id: string | null;
	activated_at: string | null;
	revoked_at: string | null;
	auth_error: string | null;
}

/**
 * The connector's state as an operator or an agent should understand it.
 *
 * Ordering is load-bearing: both auth branches sit above the local-transport
 * short-circuit, or a local connector could never be reported broken.
 */
export function connectorStatus(row: ConnectorStatusRow): ConnectorStatus {
	if (row.revoked_at) return ConnectorStatus.Revoked;
	// Was working, has stopped. Checked before Failed - the two are mutually
	// exclusive (this one needs activated_at, that one needs its absence), but
	// stating the working-to-broken case first is what keeps it from being
	// re-absorbed into Failed by a later edit.
	if (row.activated_at && row.auth_error) return ConnectorStatus.Degraded;
	if (row.auth_error && !row.activated_at) return ConnectorStatus.Failed;
	if (row.oauth_connection_id && row.activated_at) return ConnectorStatus.Active;
	// API-key connectors (provider exposes no OAuth) authenticate via a pasted
	// key stored in the vault and referenced by api_key_secret_id; the descriptor
	// emits a placeholder for it. Active once the key is stored and stamped.
	if (row.api_key_secret_id && row.activated_at) return ConnectorStatus.Active;
	// Local (stdio) connectors authenticate via credential placeholders
	// (__HEZO_SECRET_*__ - e.g. a username/password login that fetches a token),
	// not OAuth, so there is no oauth_connection_id/activated_at handshake. A
	// non-revoked, non-failed local row is connected the moment it exists.
	if (row.kind === ConnectorTransport.Local) return ConnectorStatus.Active;
	return ConnectorStatus.Pending;
}

/** The extra columns `list_connectors` consults to tell "pending" from "none". */
export interface ConnectorOAuthStatusRow extends ConnectorStatusRow {
	config: Record<string, unknown> | null;
	created_by_task_id: string | null;
}

/**
 * `list_connectors`' view of the same state.
 *
 * It differs from `connectorStatus` in two ways that are part of the tool's
 * contract, not accidents: a non-SaaS row has no OAuth story to report, and a
 * SaaS row nobody has started connecting reads as `none` rather than `pending`
 * unless a connect flow actually exists for it (a cached DCR registration, or
 * the task that requested it).
 */
export function connectorOAuthStatus(row: ConnectorOAuthStatusRow): ConnectorOAuthStatus {
	if (row.kind !== ConnectorTransport.Saas) return CONNECTOR_OAUTH_STATUS_NONE;
	const status = connectorStatus(row);
	if (status !== ConnectorStatus.Pending) return status;
	const hasDcr = !!row.config && Object.hasOwn(row.config, 'dcr');
	return hasDcr || row.created_by_task_id ? ConnectorStatus.Pending : CONNECTOR_OAUTH_STATUS_NONE;
}

/** True when the connector's tools can be expected to work right now. */
export function isConnectorUsable(status: ConnectorStatus): boolean {
	return status === ConnectorStatus.Active;
}

/**
 * True when a human has to act before this connector works. `Degraded` counts:
 * the token cannot be repaired from inside a run, only re-authorised.
 */
export function connectorNeedsHuman(status: ConnectorStatus): boolean {
	return status !== ConnectorStatus.Active;
}
