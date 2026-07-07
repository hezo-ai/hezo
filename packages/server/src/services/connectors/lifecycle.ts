import { McpConnectionKind, type McpTransport } from '@hezo/shared';
import type { Db } from '../../db/database';
import { logger } from '../../logger';

const log = logger.child('connector-lifecycle');

// Connectors are scoped by project_id (NULL = global "all projects" scope).
const CONNECTOR_COLS = `id, name, display_name, kind::text AS kind,
        config, oauth_connection_id, project_id, install_status::text AS install_status,
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
		'kind' | 'oauth_connection_id' | 'activated_at' | 'revoked_at' | 'auth_error'
	>,
): ConnectorStatus {
	if (row.revoked_at) return 'revoked';
	if (row.auth_error && !row.activated_at) return 'failed';
	if (row.oauth_connection_id && row.activated_at) return 'active';
	// Local (stdio) connectors authenticate via credential placeholders
	// (__HEZO_SECRET_*__ — e.g. a username/password login that fetches a token),
	// not OAuth, so there is no oauth_connection_id/activated_at handshake. A
	// non-revoked, non-failed local row is connected the moment it exists.
	if (row.kind === McpConnectionKind.Local) return 'active';
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
		? {
				url: input.mcpUrl,
				...(input.mcpHeaders ? { headers: input.mcpHeaders } : {}),
				...(input.mcpEnv ? { env: input.mcpEnv } : {}),
			}
		: { command: input.mcpCmd, args: input.mcpArgs ?? [], env: input.mcpEnv ?? {} };
	const kind = input.mcpUrl ? McpConnectionKind.Saas : McpConnectionKind.Local;

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

export async function markRevoked(db: Db, connectorId: string): Promise<ConnectorRow | null> {
	const result = await db.query<ConnectorRow>(
		`UPDATE mcp_connections
		 SET revoked_at = now(), oauth_connection_id = NULL, updated_at = now()
		 WHERE id = $1
		 RETURNING ${CONNECTOR_COLS}`,
		[connectorId],
	);
	return result.rows[0] ?? null;
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
