import type { PGlite } from '@electric-sql/pglite';
import { McpConnectionKind, type McpTransport } from '@hezo/shared';
import { logger } from '../../logger';

const log = logger.child('connector-lifecycle');

export interface CreateConnectorInput {
	teamId: string;
	projectId?: string | null;
	name: string;
	displayName: string;
	mcpUrl?: string;
	mcpCmd?: string;
	mcpTransport: McpTransport;
	mcpEnv?: Record<string, string>;
	mcpArgs?: string[];
	skillDocId?: string | null;
	createdByTaskId?: string | null;
	providerId?: string | null;
}

export interface ConnectorRow {
	id: string;
	team_id: string;
	project_id: string | null;
	name: string;
	display_name: string | null;
	kind: string;
	config: Record<string, unknown>;
	oauth_connection_id: string | null;
	install_status: string;
	install_error: string | null;
	skill_doc_id: string | null;
	created_by_task_id: string | null;
	activated_at: string | null;
	revoked_at: string | null;
	auth_error: string | null;
	created_at: string;
	updated_at: string;
}

export type ConnectorStatus = 'pending' | 'active' | 'failed' | 'revoked';

export function statusOf(
	row: Pick<ConnectorRow, 'oauth_connection_id' | 'activated_at' | 'revoked_at' | 'auth_error'>,
): ConnectorStatus {
	if (row.revoked_at) return 'revoked';
	if (row.auth_error && !row.activated_at) return 'failed';
	if (row.oauth_connection_id && row.activated_at) return 'active';
	return 'pending';
}

/**
 * Idempotently create or fetch a connector. If a connector with the same
 * (team_id, project_id, name) tuple already exists, returns the existing row
 * without modification. The caller decides whether to treat an existing
 * active connector as "already done".
 */
export async function createOrFetchConnector(
	db: PGlite,
	input: CreateConnectorInput,
): Promise<{ row: ConnectorRow; alreadyExisted: boolean }> {
	const existing = await db.query<ConnectorRow>(
		`SELECT id, team_id, project_id, name, display_name, kind::text AS kind,
		        config, oauth_connection_id, install_status::text AS install_status,
		        install_error, skill_doc_id, created_by_task_id,
		        activated_at::text AS activated_at, revoked_at::text AS revoked_at, auth_error,
		        created_at::text AS created_at, updated_at::text AS updated_at
		 FROM mcp_connections
		 WHERE team_id = $1 AND project_id IS NOT DISTINCT FROM $2 AND name = $3`,
		[input.teamId, input.projectId ?? null, input.name],
	);
	const existingRow = existing.rows[0];
	if (existingRow) {
		// If this row was previously revoked, restore it for re-authorization.
		if (existingRow.revoked_at) {
			await db.query(
				`UPDATE mcp_connections
				 SET revoked_at = NULL, auth_error = NULL, oauth_connection_id = NULL,
				     activated_at = NULL, updated_at = now()
				 WHERE id = $1`,
				[existingRow.id],
			);
			return {
				row: {
					...existingRow,
					revoked_at: null,
					auth_error: null,
					oauth_connection_id: null,
					activated_at: null,
				},
				alreadyExisted: true,
			};
		}
		return { row: existingRow, alreadyExisted: true };
	}

	const config: Record<string, unknown> = input.mcpUrl
		? { url: input.mcpUrl, ...(input.mcpEnv ? { env: input.mcpEnv } : {}) }
		: { command: input.mcpCmd, args: input.mcpArgs ?? [], env: input.mcpEnv ?? {} };
	const kind = input.mcpUrl ? McpConnectionKind.Saas : McpConnectionKind.Local;

	const inserted = await db.query<ConnectorRow>(
		`INSERT INTO mcp_connections (
		    team_id, project_id, name, display_name, kind, config,
		    install_status, skill_doc_id, created_by_task_id
		 )
		 VALUES (
		    $1, $2, $3, $4, $5::mcp_connection_kind, $6::jsonb,
		    'pending'::mcp_install_status, $7, $8
		 )
		 RETURNING id, team_id, project_id, name, display_name, kind::text AS kind,
		           config, oauth_connection_id, install_status::text AS install_status,
		           install_error, skill_doc_id, created_by_task_id,
		           activated_at::text AS activated_at, revoked_at::text AS revoked_at, auth_error,
		           created_at::text AS created_at, updated_at::text AS updated_at`,
		[
			input.teamId,
			input.projectId ?? null,
			input.name,
			input.displayName,
			kind,
			JSON.stringify(config),
			input.skillDocId ?? null,
			input.createdByTaskId ?? null,
		],
	);
	log.info('connector created', {
		connectorId: inserted.rows[0]!.id,
		teamId: input.teamId,
		name: input.name,
	});
	return { row: inserted.rows[0]!, alreadyExisted: false };
}

export async function markActive(
	db: PGlite,
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
		 RETURNING id, team_id, project_id, name, display_name, kind::text AS kind,
		           config, oauth_connection_id, install_status::text AS install_status,
		           install_error, skill_doc_id, created_by_task_id,
		           activated_at::text AS activated_at, revoked_at::text AS revoked_at, auth_error,
		           created_at::text AS created_at, updated_at::text AS updated_at`,
		[oauthConnectionId, connectorId],
	);
	return result.rows[0] ?? null;
}

export async function markFailed(
	db: PGlite,
	connectorId: string,
	reason: string,
): Promise<ConnectorRow | null> {
	const result = await db.query<ConnectorRow>(
		`UPDATE mcp_connections
		 SET auth_error = $1, updated_at = now()
		 WHERE id = $2
		 RETURNING id, team_id, project_id, name, display_name, kind::text AS kind,
		           config, oauth_connection_id, install_status::text AS install_status,
		           install_error, skill_doc_id, created_by_task_id,
		           activated_at::text AS activated_at, revoked_at::text AS revoked_at, auth_error,
		           created_at::text AS created_at, updated_at::text AS updated_at`,
		[reason, connectorId],
	);
	return result.rows[0] ?? null;
}

export async function markRevoked(db: PGlite, connectorId: string): Promise<ConnectorRow | null> {
	const result = await db.query<ConnectorRow>(
		`UPDATE mcp_connections
		 SET revoked_at = now(), oauth_connection_id = NULL, updated_at = now()
		 WHERE id = $1
		 RETURNING id, team_id, project_id, name, display_name, kind::text AS kind,
		           config, oauth_connection_id, install_status::text AS install_status,
		           install_error, skill_doc_id, created_by_task_id,
		           activated_at::text AS activated_at, revoked_at::text AS revoked_at, auth_error,
		           created_at::text AS created_at, updated_at::text AS updated_at`,
		[connectorId],
	);
	return result.rows[0] ?? null;
}

export async function getConnector(db: PGlite, connectorId: string): Promise<ConnectorRow | null> {
	const result = await db.query<ConnectorRow>(
		`SELECT id, team_id, project_id, name, display_name, kind::text AS kind,
		        config, oauth_connection_id, install_status::text AS install_status,
		        install_error, skill_doc_id, created_by_task_id,
		        activated_at::text AS activated_at, revoked_at::text AS revoked_at, auth_error,
		        created_at::text AS created_at, updated_at::text AS updated_at
		 FROM mcp_connections
		 WHERE id = $1`,
		[connectorId],
	);
	return result.rows[0] ?? null;
}

/**
 * Load all team-scoped MCP skill files (documents with type='mcp_skill') so
 * the agent runner can pass them into the per-adapter MCP injection. Returns
 * `{slug, content}` pairs suitable for `McpAdapterContext.skillFiles`.
 */
export async function loadSkillFilesForTeam(
	db: PGlite,
	teamId: string,
): Promise<Array<{ slug: string; content: string }>> {
	const result = await db.query<{ slug: string; content: string }>(
		`SELECT slug, content FROM documents
		 WHERE team_id = $1 AND type = 'mcp_skill'::document_type
		 ORDER BY slug ASC`,
		[teamId],
	);
	return result.rows;
}

export async function listConnectorsForTeam(db: PGlite, teamId: string): Promise<ConnectorRow[]> {
	const result = await db.query<ConnectorRow>(
		`SELECT id, team_id, project_id, name, display_name, kind::text AS kind,
		        config, oauth_connection_id, install_status::text AS install_status,
		        install_error, skill_doc_id, created_by_task_id,
		        activated_at::text AS activated_at, revoked_at::text AS revoked_at, auth_error,
		        created_at::text AS created_at, updated_at::text AS updated_at
		 FROM mcp_connections
		 WHERE team_id = $1
		 ORDER BY created_at ASC`,
		[teamId],
	);
	return result.rows;
}
