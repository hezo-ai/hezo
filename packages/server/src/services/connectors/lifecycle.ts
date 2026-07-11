import { ConnectorTransport, type McpTransport, WakeupSource } from '@hezo/shared';
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
	/** Owning project, or null for a global ("all projects") connector. */
	projectId?: string | null;
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
	created_at: string;
	updated_at: string;
}

export type ConnectorStatus = 'pending' | 'active' | 'failed' | 'revoked';

export function statusOf(
	row: Pick<
		ConnectorRow,
		| 'kind'
		| 'oauth_connection_id'
		| 'api_key_secret_id'
		| 'activated_at'
		| 'revoked_at'
		| 'auth_error'
	>,
): ConnectorStatus {
	if (row.revoked_at) return 'revoked';
	if (row.auth_error && !row.activated_at) return 'failed';
	if (row.oauth_connection_id && row.activated_at) return 'active';
	// API-key connectors (provider exposes no OAuth) authenticate via a pasted
	// key stored in the vault and referenced by api_key_secret_id; the descriptor
	// emits a placeholder for it. Active once the key is stored and stamped.
	if (row.api_key_secret_id && row.activated_at) return 'active';
	// Local (stdio) connectors authenticate via credential placeholders
	// (__HEZO_SECRET_*__ — e.g. a username/password login that fetches a token),
	// not OAuth, so there is no oauth_connection_id/activated_at handshake. A
	// non-revoked, non-failed local row is connected the moment it exists.
	if (row.kind === ConnectorTransport.Local) return 'active';
	return 'pending';
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
		// If this row was previously revoked, restore it for re-authorization.
		if (existingRow.revoked_at) {
			const restored = await restoreRevokedConnector(db, existingRow.id);
			return { row: restored ?? existingRow, alreadyExisted: true };
		}
		return { row: existingRow, alreadyExisted: true };
	}

	const config: Record<string, unknown> = input.mcpUrl
		? {
				url: input.mcpUrl,
				...(input.mcpHeaders ? { headers: input.mcpHeaders } : {}),
				...(input.mcpEnv ? { env: input.mcpEnv } : {}),
			}
		: { command: input.mcpCmd, args: input.mcpArgs ?? [], env: input.mcpEnv ?? {} };
	const kind = input.mcpUrl ? ConnectorTransport.Saas : ConnectorTransport.Local;

	const inserted = await db.query<ConnectorRow>(
		`INSERT INTO mcp_connections (
		    name, display_name, kind, config,
		    install_status, skill_id, created_by_task_id, project_id
		 )
		 VALUES (
		    $1, $2, $3::mcp_connection_kind, $4::jsonb,
		    'pending'::mcp_install_status, $5, $6, $7
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
		],
	);
	log.info('connector created', {
		connectorId: inserted.rows[0]!.id,
		name: input.name,
	});
	return { row: inserted.rows[0]!, alreadyExisted: false };
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
