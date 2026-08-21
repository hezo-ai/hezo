import {
	ConnectorAccess,
	type ConnectorStatus,
	ConnectorTransport,
	connectorStatus,
	type LinkedRepo,
	type McpTransport,
	WakeupSource,
} from '@hezo/shared';

export type { LinkedRepo };

import type { Db } from '../../db/database';
import { trackBackground } from '../../lib/background';
import { logger } from '../../logger';
import { createWakeup } from '../wakeup';

const log = logger.child('connector-lifecycle');

// Connectors are scoped by project_id (NULL = global "all projects" scope).
const CONNECTOR_COLS = `id, name, display_name, kind::text AS kind,
        config, oauth_connection_id, api_key_secret_id, project_id, install_status::text AS install_status,
        install_error, skill_id, created_by_task_id,
        activated_at::text AS activated_at, revoked_at::text AS revoked_at, auth_error,
        requested_access::text AS requested_access, access_applied_at::text AS access_applied_at,
        probed_at::text AS probed_at, probe_error::text AS probe_error,
        created_at::text AS created_at, updated_at::text AS updated_at`;

export interface CreateConnectorInput {
	name: string;
	displayName: string;
	mcpUrl?: string;
	mcpHeaders?: Record<string, string>;
	mcpCmd?: string;
	mcpTransport: McpTransport;
	mcpEnv?: Record<string, string>;
	mcpArgs?: string[];
	skillId?: string | null;
	createdByTaskId?: string | null;
	providerId?: string | null;
	/**
	 * Explicit transport. When `Api`, the row is created as a REST-API connector
	 * from {@link apiConfig} instead of inferring saas/local from `mcpUrl`. Omit
	 * for the default MCP-server path.
	 */
	kind?: ConnectorTransport;
	/**
	 * Full `config` for an `Api` connector — the validated {@link ApiConnectorConfig}
	 * plus any `oauth_provider_id` preset (the bundled OAuth-broker provider the
	 * completion UI locks onto). Only read when `kind === Api`.
	 */
	apiConfig?: Record<string, unknown>;
	/** Owning project, or null for a global ("all projects") connector. */
	projectId?: string | null;
	/**
	 * The access the registering agent asked for. `Read` makes discovery disable
	 * every write method the server advertises, once, on connect. `Write` is
	 * today's behaviour and is stored only as a record of what was asked.
	 *
	 * This is a *request*, not a grant — it is applied only while the operator has
	 * not decided anything themselves (see `discoverConnectorMethods`).
	 */
	requestedAccess?: ConnectorAccess | null;
}

export interface ConnectorRow {
	id: string;
	name: string;
	display_name: string | null;
	kind: string;
	config: Record<string, unknown>;
	oauth_connection_id: string | null;
	api_key_secret_id: string | null;
	project_id: string | null;
	install_status: string;
	install_error: string | null;
	skill_id: string | null;
	created_by_task_id: string | null;
	activated_at: string | null;
	revoked_at: string | null;
	auth_error: string | null;
	requested_access: string | null;
	access_applied_at: string | null;
	/** When Hezo last probed the server, of any outcome. Null means never. */
	probed_at: string | null;
	/** Why that probe failed; null when it completed the MCP handshake. */
	probe_error: string | null;
	created_at: string;
	updated_at: string;
}

export type { ConnectorStatus };

/**
 * The ladder itself lives in `@hezo/shared` so the server, the web and the
 * `list_connectors` MCP tool cannot drift apart on what "connected" means (they
 * did, and a connector with a dead token reported `active` on all three).
 */
export function statusOf(
	row: Pick<
		ConnectorRow,
		| 'kind'
		| 'config'
		| 'oauth_connection_id'
		| 'api_key_secret_id'
		| 'activated_at'
		| 'revoked_at'
		| 'auth_error'
		| 'probed_at'
		| 'probe_error'
	>,
): ConnectorStatus {
	return connectorStatus(row);
}

/**
 * Idempotently create or fetch a connector. Connectors are scoped by project, so
 * the idempotency key is `(project_id, name)`. The lookup is *strictly* scoped —
 * it must NOT fall back to a global row of the same name, or a project's "connect"
 * would return another project's (or the shared global) connector and its token,
 * reintroducing the cross-project bleed. If one already exists in this scope,
 * returns it without modification (restoring a previously-revoked row for
 * re-authorization).
 */
export async function createOrFetchConnector(
	db: Db,
	input: CreateConnectorInput,
): Promise<{ row: ConnectorRow; alreadyExisted: boolean }> {
	const projectId = input.projectId ?? null;
	const existing = await db.query<ConnectorRow>(
		`SELECT ${CONNECTOR_COLS} FROM mcp_connections
		 WHERE name = $1 AND project_id IS NOT DISTINCT FROM $2`,
		[input.name, projectId],
	);
	const existingRow = existing.rows[0];
	if (existingRow) {
		// If this row was previously revoked, restore it for re-authorization. The
		// access columns survive the restore, so a reconnect keeps the restriction.
		if (existingRow.revoked_at) {
			const restored = await restoreRevokedConnector(db, existingRow.id);
			const narrowed = await narrowRequestedAccess(db, restored ?? existingRow, input);
			return { row: narrowed, alreadyExisted: true };
		}
		// Re-registering an api connector with a broker provider preset the row
		// doesn't yet carry: patch it onto the (still-pending) row so the preset
		// isn't silently dropped. Never touch an already-active row's config.
		const presetProvider =
			input.kind === ConnectorTransport.Api
				? (input.apiConfig?.oauth_provider_id as string | undefined)
				: undefined;
		const existingProvider = (existingRow.config as { oauth_provider_id?: unknown })
			.oauth_provider_id;
		if (presetProvider && existingProvider !== presetProvider && !existingRow.activated_at) {
			const patched = await db.query<ConnectorRow>(
				`UPDATE mcp_connections
				 SET config = jsonb_set(config, '{oauth_provider_id}', $1::jsonb), updated_at = now()
				 WHERE id = $2
				 RETURNING ${CONNECTOR_COLS}`,
				[JSON.stringify(presetProvider), existingRow.id],
			);
			return {
				row: await narrowRequestedAccess(db, patched.rows[0] ?? existingRow, input),
				alreadyExisted: true,
			};
		}
		return { row: await narrowRequestedAccess(db, existingRow, input), alreadyExisted: true };
	}

	// An explicit `Api` kind builds the row from the validated api config
	// (base_url / allowed_hosts / auth, plus any oauth_provider_id preset). The
	// default path still infers saas (mcpUrl) vs local (command) so the
	// DCR/auth-start flow is unchanged.
	const config: Record<string, unknown> =
		input.kind === ConnectorTransport.Api
			? (input.apiConfig ?? {})
			: input.mcpUrl
				? {
						url: input.mcpUrl,
						...(input.mcpHeaders ? { headers: input.mcpHeaders } : {}),
						...(input.mcpEnv ? { env: input.mcpEnv } : {}),
					}
				: { command: input.mcpCmd, args: input.mcpArgs ?? [], env: input.mcpEnv ?? {} };
	const kind =
		input.kind === ConnectorTransport.Api
			? ConnectorTransport.Api
			: input.mcpUrl
				? ConnectorTransport.Saas
				: ConnectorTransport.Local;

	const inserted = await db.query<ConnectorRow>(
		`INSERT INTO mcp_connections (
		    name, display_name, kind, config,
		    install_status, skill_id, created_by_task_id, project_id, requested_access
		 )
		 VALUES (
		    $1, $2, $3::mcp_connection_kind, $4::jsonb,
		    'pending'::mcp_install_status, $5, $6, $7, $8::connector_access
		 )
		 RETURNING ${CONNECTOR_COLS}`,
		[
			input.name,
			input.displayName,
			kind,
			JSON.stringify(config),
			input.skillId ?? null,
			input.createdByTaskId ?? null,
			projectId,
			input.requestedAccess ?? null,
		],
	);
	log.info('connector created', {
		connectorId: inserted.rows[0]!.id,
		name: input.name,
		requestedAccess: input.requestedAccess ?? null,
	});
	return { row: inserted.rows[0]!, alreadyExisted: false };
}

/**
 * Record a read-only request onto a connector row that already exists.
 *
 * Narrowing only, and only while nothing has been decided yet. `write` is not an
 * escalation — it never clears a stored `read` request and never touches an
 * allowlist — so re-registering a connector can tighten access but never widen
 * it. The guard is the same one discovery applies: once a read request has been
 * applied (`access_applied_at`) or an operator has set an allowlist
 * (`enabled_methods`), the decision is theirs and a re-register does not disturb
 * it.
 */
async function narrowRequestedAccess(
	db: Db,
	row: ConnectorRow,
	input: CreateConnectorInput,
): Promise<ConnectorRow> {
	if (input.requestedAccess !== ConnectorAccess.Read) return row;
	if (row.requested_access === ConnectorAccess.Read) return row;
	const updated = await db.query<ConnectorRow>(
		`UPDATE mcp_connections
		 SET requested_access = 'read'::connector_access, updated_at = now()
		 WHERE id = $1 AND access_applied_at IS NULL AND enabled_methods IS NULL
		 RETURNING ${CONNECTOR_COLS}`,
		[row.id],
	);
	return updated.rows[0] ?? row;
}

export async function markActive(
	db: Db,
	connectorId: string,
	oauthConnectionId: string,
): Promise<ConnectorRow | null> {
	const result = await db.query<ConnectorRow>(
		`UPDATE mcp_connections
		 SET oauth_connection_id = $1,
		     activated_at = now(),
		     auth_error = NULL,
		     revoked_at = NULL,
		     install_status = 'installed'::mcp_install_status,
		     updated_at = now()
		 WHERE id = $2
		 RETURNING ${CONNECTOR_COLS}`,
		[oauthConnectionId, connectorId],
	);
	return result.rows[0] ?? null;
}

export async function markFailed(
	db: Db,
	connectorId: string,
	reason: string,
): Promise<ConnectorRow | null> {
	const result = await db.query<ConnectorRow>(
		`UPDATE mcp_connections
		 SET auth_error = $1, updated_at = now()
		 WHERE id = $2
		 RETURNING ${CONNECTOR_COLS}`,
		[reason, connectorId],
	);
	return result.rows[0] ?? null;
}

/**
 * Activate a connector authenticated by a pasted API key. The key itself lives
 * in the vault `secrets` row `apiKeySecretId`; here we only link the row and
 * stamp it active. `apiKey` persists the (non-default) header/scheme the
 * descriptor uses to carry the placeholder.
 */
export async function markApiKeyActive(
	db: Db,
	connectorId: string,
	apiKeySecretId: string,
	apiKey: { header?: string; scheme?: string } | null,
): Promise<ConnectorRow | null> {
	const result = await db.query<ConnectorRow>(
		`UPDATE mcp_connections
		 SET api_key_secret_id = $1,
		     config = CASE WHEN $2::jsonb IS NULL THEN config - 'apiKey'
		                   ELSE jsonb_set(config, '{apiKey}', $2::jsonb) END,
		     activated_at = now(),
		     auth_error = NULL,
		     revoked_at = NULL,
		     install_status = 'installed'::mcp_install_status,
		     updated_at = now()
		 WHERE id = $3
		 RETURNING ${CONNECTOR_COLS}`,
		[apiKeySecretId, apiKey ? JSON.stringify(apiKey) : null, connectorId],
	);
	return result.rows[0] ?? null;
}

export async function markRevoked(db: Db, connectorId: string): Promise<ConnectorRow | null> {
	const result = await db.query<ConnectorRow>(
		`UPDATE mcp_connections
		 SET revoked_at = now(), oauth_connection_id = NULL, api_key_secret_id = NULL, updated_at = now()
		 WHERE id = $1
		 RETURNING ${CONNECTOR_COLS}`,
		[connectorId],
	);
	return result.rows[0] ?? null;
}

/**
 * Restore a previously-revoked connector to a clean, re-authorizable state — the
 * "fresh replacement" a user gets by clicking Connect (or pasting an API key) on
 * a revoked row, instead of being told to recreate it. Clears the revocation and
 * every auth artifact (linked OAuth connection, pasted API key, activation stamp,
 * prior auth error) while preserving the connector's identity and `config` —
 * including any cached DCR client registration, still valid at the Authorization
 * Server, so a reconnect skips re-registration. The revoke path already purged
 * the old token / key secret from the vault, so this only resets the row.
 * Returns null on a non-existent id.
 */
export async function restoreRevokedConnector(
	db: Db,
	connectorId: string,
): Promise<ConnectorRow | null> {
	const result = await db.query<ConnectorRow>(
		`UPDATE mcp_connections
		 SET revoked_at = NULL, auth_error = NULL, oauth_connection_id = NULL,
		     api_key_secret_id = NULL, activated_at = NULL, updated_at = now()
		 WHERE id = $1
		 RETURNING ${CONNECTOR_COLS}`,
		[connectorId],
	);
	return result.rows[0] ?? null;
}

/**
 * Fire a CredentialProvided wakeup on the assignee of the task that requested
 * the connector, if any. Fire-and-forget — the agent's run is inherently async.
 *
 * The wakeup's team is resolved from the requesting task itself, not from
 * whoever completed the connect: connectors are global, so the connect (OAuth
 * dance, or an API-key paste) can finish from another project's Connectors page
 * or from the instance settings page (no team context at all), while the
 * waiting agent lives in the task's team.
 */
export async function fireCredentialProvidedWakeup(
	db: Db,
	connector: Pick<ConnectorRow, 'id' | 'created_by_task_id'>,
): Promise<void> {
	if (!connector.created_by_task_id) return;
	const row = await db.query<{ assignee_id: string | null; team_id: string }>(
		`SELECT assignee_id, team_id FROM tasks WHERE id = $1`,
		[connector.created_by_task_id],
	);
	const assigneeId = row.rows[0]?.assignee_id;
	const taskTeamId = row.rows[0]?.team_id;
	if (!assigneeId || !taskTeamId) return;
	trackBackground(
		createWakeup(
			db,
			assigneeId,
			taskTeamId,
			WakeupSource.CredentialProvided,
			{ connector_id: connector.id, task_id: connector.created_by_task_id },
			`connector:${connector.id}`,
		).catch((e) => log.warn('wakeup enqueue failed (non-fatal)', { error: (e as Error).message })),
	);
}

export async function getConnector(db: Db, connectorId: string): Promise<ConnectorRow | null> {
	const result = await db.query<ConnectorRow>(
		`SELECT ${CONNECTOR_COLS} FROM mcp_connections WHERE id = $1`,
		[connectorId],
	);
	return result.rows[0] ?? null;
}

/**
 * The repos riding a connector's OAuth connection, across every project of one
 * team.
 *
 * Not PROJECT-filtered, deliberately: a connection can back repos in more than
 * one project (migration `018_scope_connections_per_project.sql` leaves exactly
 * those global), so scoping this to the caller's project would under-report the
 * case with the widest blast radius. The converse does not hold - a global
 * connection may back one project's repos or none - so do not read "global" as
 * "shared".
 *
 * It IS team-filtered, which is a different boundary. A global connector is
 * visible from every project on the instance, other teams' included, so an
 * unfiltered query hands the caller repo identifiers and project names from
 * teams that `requireProjectAccessMiddleware` answers 403 for. Pass `null` only
 * for an admin surface that is meant to see every team.
 *
 * This is disclosure scoping, not protection scoping: the delete guard in
 * `deleteConnector` counts repos in EVERY team, so a connector still cannot be
 * removed out from under a repo the caller cannot see. It only changes which of
 * them may be named back.
 *
 * The join is null-safe - a connector with no `oauth_connection_id` matches
 * nothing, because `NULL = NULL` is not true - so no special case is needed.
 * Indexed by `idx_repos_oauth_connection`.
 */
export async function linkedReposForConnector(
	db: Db,
	connectorId: string,
	teamId: string | null,
): Promise<LinkedRepo[]> {
	const result = await db.query<LinkedRepo>(
		`SELECT r.id, r.repo_identifier, r.project_id, p.name AS project_name
		   FROM repos r
		   JOIN mcp_connections mc ON mc.oauth_connection_id = r.oauth_connection_id
		   JOIN projects p ON p.id = r.project_id
		  WHERE mc.id = $1${teamId ? ' AND p.team_id = $2' : ''}
		  ORDER BY p.name ASC, r.repo_identifier ASC`,
		teamId ? [connectorId, teamId] : [connectorId],
	);
	return result.rows;
}

/**
 * The same linkage, batched by OAuth connection id, for a list route that would
 * otherwise loop. One query for the whole page rather than one per row - the
 * repos list is small, but a per-row lookup is the shape AGENTS.md rules out
 * ("Fold repeated lookups into one query, batch or join instead of looping").
 * Connections with no repos are simply absent from the map.
 */
export async function linkedReposByConnection(
	db: Db,
	connectionIds: readonly string[],
	teamId: string | null,
): Promise<Map<string, LinkedRepo[]>> {
	const out = new Map<string, LinkedRepo[]>();
	if (connectionIds.length === 0) return out;
	const result = await db.query<LinkedRepo & { oauth_connection_id: string }>(
		`SELECT r.id, r.repo_identifier, r.project_id, p.name AS project_name,
		        r.oauth_connection_id
		   FROM repos r
		   JOIN projects p ON p.id = r.project_id
		  WHERE r.oauth_connection_id = ANY($1::uuid[])${teamId ? ' AND p.team_id = $2' : ''}
		  ORDER BY p.name ASC, r.repo_identifier ASC`,
		teamId ? [connectionIds as string[], teamId] : [connectionIds as string[]],
	);
	for (const row of result.rows) {
		const list = out.get(row.oauth_connection_id);
		const entry: LinkedRepo = {
			id: row.id,
			repo_identifier: row.repo_identifier,
			project_id: row.project_id,
			project_name: row.project_name,
		};
		if (list) list.push(entry);
		else out.set(row.oauth_connection_id, [entry]);
	}
	return out;
}

export interface DeleteConnectorOptions {
	/** Match `name` as well as `id` - the MCP tool's selector, not the REST one. */
	matchName?: boolean;
	/** Restrict to one project's own rows. Omit for the instance-admin path,
	 *  which may delete a global row. */
	projectId?: string;
	/**
	 * Refuse when the connector's OAuth connection still backs linked repos.
	 *
	 * On for agent callers, off for humans, and that asymmetry is the point: a
	 * human may legitimately want the MCP tools gone while git keeps working, but
	 * an agent doing it strips a human-configured capability whose loss shows up
	 * nowhere. Withholding the capability from agents is the same call the
	 * codebase already makes for asset deletion ("hard deletion is admin-only").
	 */
	guardLinkedRepos?: boolean;
	/**
	 * Whose team may be NAMED in a `backs_linked_repos` refusal. Disclosure
	 * scoping only - the guard itself counts every team's repos, so a connector
	 * is never removed out from under a repo the caller cannot see. `null` is the
	 * admin surface, which may see all of them. Required whenever
	 * `guardLinkedRepos` is set; ignored otherwise.
	 */
	discloseTeamId?: string | null;
}

export type DeleteConnectorResult =
	| { outcome: 'deleted'; id: string; name: string }
	| { outcome: 'not_found' }
	| {
			outcome: 'backs_linked_repos';
			id: string;
			name: string;
			/**
			 * The repos the caller is allowed to be told about. May be EMPTY while the
			 * refusal still stands, when every blocking repo sits in another team -
			 * so never derive the count from this array. `totalRepoCount` is what the
			 * guard actually counted.
			 */
			repos: LinkedRepo[];
			/** Every repo the guard counted, across all teams. */
			totalRepoCount: number;
	  };

/**
 * Delete a connector row, optionally refusing when it still backs linked repos.
 *
 * One home for what were three hand-written `DELETE FROM mcp_connections`
 * statements with three different WHERE clauses, so a guard cannot be added to
 * one path and missed on the others.
 */
export async function deleteConnector(
	db: Db,
	idOrName: string,
	opts: DeleteConnectorOptions = {},
): Promise<DeleteConnectorResult> {
	const match = opts.matchName ? '(id::text = $1 OR name = $1)' : 'id = $1';
	const params: unknown[] = [idOrName];
	let scope = '';
	if (opts.projectId != null) {
		params.push(opts.projectId);
		scope = ` AND project_id = $${params.length}`;
	}
	// The guard rides the DELETE's own WHERE rather than a preceding SELECT so it
	// is atomic, for the same reason `add_connector` gives for its ON CONFLICT
	// guard: a check-then-delete could be raced by a concurrent repo link.
	const guard = opts.guardLinkedRepos
		? ` AND NOT EXISTS (
			     SELECT 1 FROM repos r
			      WHERE r.oauth_connection_id = mcp_connections.oauth_connection_id
		     )`
		: '';
	const deleted = await db.query<{ id: string; name: string }>(
		`DELETE FROM mcp_connections WHERE ${match}${scope}${guard} RETURNING id, name`,
		params,
	);
	const gone = deleted.rows[0];
	if (gone) return { outcome: 'deleted', id: gone.id, name: gone.name };

	// Zero rows is either "no such row in scope" or "the guard suppressed it".
	const existing = await db.query<{ id: string; name: string }>(
		`SELECT id, name FROM mcp_connections WHERE ${match}${scope}`,
		params,
	);
	const row = existing.rows[0];
	if (!row) return { outcome: 'not_found' };
	// Two reads, deliberately: the guard is instance-wide, so the COUNT must be
	// too, while the names are scoped to what the caller may see. Deriving the
	// count from the scoped list produced "still authenticates 0 linked repo(s)"
	// on a cross-team block, which reads as the guard misfiring.
	const [repos, total] = await Promise.all([
		linkedReposForConnector(db, row.id, opts.discloseTeamId ?? null),
		linkedReposForConnector(db, row.id, null).then((all) => all.length),
	]);
	return {
		outcome: 'backs_linked_repos',
		id: row.id,
		name: row.name,
		repos,
		totalRepoCount: total,
	};
}

/**
 * List connectors. With `projectId`, returns that project's own connectors plus
 * global ("all projects") ones; omit for the instance-admin view (all rows).
 */
export async function listConnectors(db: Db, projectId?: string | null): Promise<ConnectorRow[]> {
	if (projectId != null) {
		const result = await db.query<ConnectorRow>(
			`SELECT ${CONNECTOR_COLS} FROM mcp_connections
			 WHERE project_id = $1 OR project_id IS NULL
			 ORDER BY created_at ASC`,
			[projectId],
		);
		return result.rows;
	}
	const result = await db.query<ConnectorRow>(
		`SELECT ${CONNECTOR_COLS} FROM mcp_connections ORDER BY created_at ASC`,
	);
	return result.rows;
}
