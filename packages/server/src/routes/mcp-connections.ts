import { getConnectorCapability, McpConnectionKind, wsRoom } from '@hezo/shared';
import { Hono } from 'hono';
import { trackBackground } from '../lib/background';
import { broadcastChange } from '../lib/broadcast';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { logger } from '../logger';
import { requireSuperuser } from '../middleware/auth';
import { createOrFetchConnector } from '../services/connectors/lifecycle';
import { installLocalMcpById } from '../services/mcp-installer';

const log = logger.child('mcp-connections-route');

export const mcpConnectionsRoutes = new Hono<Env>();

mcpConnectionsRoutes.get('/teams/:teamId/mcp-connections', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const projectId = c.req.query('project_id') ?? null;

	const params: unknown[] = [teamId];
	let where = '(team_id = $1 OR team_id IS NULL)';
	if (projectId) {
		where += ' AND (project_id IS NULL OR project_id = $2)';
		params.push(projectId);
	}
	const result = await db.query(
		`SELECT id, team_id, project_id, name, display_name, kind::text AS kind,
		        config, oauth_connection_id, install_status::text AS install_status, install_error,
		        skill_doc_id, created_by_task_id, activated_at, revoked_at, auth_error,
		        created_at, updated_at
		 FROM mcp_connections
		 WHERE ${where}
		 ORDER BY name ASC`,
		params,
	);
	return ok(c, result.rows);
});

// Instance-level connectors (team_id NULL) are shared across every team. The
// Admin (superuser) manages them here; the per-team connector reads include
// them. Only SaaS (remote URL) connectors are supported at the instance level
// — local (stdio) MCPs carry per-container install state that can't be shared
// across teams from a single row, so those stay per-team.
mcpConnectionsRoutes.get('/mcp-connections', async (c) => {
	const denied = requireSuperuser(c);
	if (denied) return denied;
	const db = c.get('db');
	const result = await db.query(
		`SELECT id, team_id, project_id, name, display_name, kind::text AS kind,
		        config, oauth_connection_id, install_status::text AS install_status, install_error,
		        skill_doc_id, created_by_task_id, activated_at, revoked_at, auth_error,
		        created_at, updated_at
		 FROM mcp_connections
		 WHERE team_id IS NULL
		 ORDER BY name ASC`,
	);
	return ok(c, result.rows);
});

mcpConnectionsRoutes.post('/mcp-connections', async (c) => {
	const denied = requireSuperuser(c);
	if (denied) return denied;
	const db = c.get('db');

	const body = await c.req.json<{
		name: string;
		display_name?: string;
		kind: 'saas' | 'local';
		config: Record<string, unknown>;
	}>();

	if (!body.name?.trim()) {
		return err(c, 'INVALID_REQUEST', 'name is required', 400);
	}
	if (body.kind !== McpConnectionKind.Saas) {
		return err(
			c,
			'INVALID_REQUEST',
			'instance-level connectors must be "saas"; local MCPs are created per-team',
			400,
		);
	}
	const url = body.config?.url;
	if (typeof url !== 'string' || !url) {
		return err(c, 'INVALID_REQUEST', 'saas connections require config.url (string)', 400);
	}

	const result = await db.query(
		`INSERT INTO mcp_connections (team_id, project_id, name, display_name, kind, config, install_status)
		 VALUES (NULL, NULL, $1, $2, $3::mcp_connection_kind, $4::jsonb, 'installed'::mcp_install_status)
		 ON CONFLICT (name) WHERE team_id IS NULL DO UPDATE
		 SET display_name = EXCLUDED.display_name,
		     kind = EXCLUDED.kind,
		     config = EXCLUDED.config,
		     install_status = EXCLUDED.install_status,
		     install_error = NULL,
		     updated_at = now()
		 RETURNING id, team_id, project_id, name, display_name, kind::text AS kind,
		           config, oauth_connection_id, install_status::text AS install_status, install_error,
		           created_at, updated_at`,
		[body.name.trim(), body.display_name?.trim() ?? null, body.kind, JSON.stringify(body.config)],
	);

	return ok(c, result.rows[0], 201);
});

mcpConnectionsRoutes.delete('/mcp-connections/:id', async (c) => {
	const denied = requireSuperuser(c);
	if (denied) return denied;
	const db = c.get('db');
	const id = c.req.param('id');
	const result = await db.query<{ id: string }>(
		'DELETE FROM mcp_connections WHERE id = $1 AND team_id IS NULL RETURNING id',
		[id],
	);
	if (result.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'instance connector not found', 404);
	}
	return c.json({ data: null }, 200);
});

mcpConnectionsRoutes.get('/teams/:teamId/mcp-connections/:id', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const id = c.req.param('id');
	const result = await db.query(
		`SELECT id, team_id, project_id, name, display_name, kind::text AS kind,
		        config, oauth_connection_id, install_status::text AS install_status, install_error,
		        skill_doc_id, created_by_task_id, activated_at, revoked_at, auth_error,
		        created_at, updated_at
		 FROM mcp_connections
		 WHERE id = $1 AND team_id = $2`,
		[id, teamId],
	);
	if (result.rows.length === 0) return err(c, 'NOT_FOUND', 'connector not found', 404);
	return ok(c, result.rows[0]);
});

mcpConnectionsRoutes.post('/teams/:teamId/mcp-connections/:id/revoke', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const id = c.req.param('id');
	const { markRevoked } = await import('../services/connectors/lifecycle');
	const existing = await db.query<{ team_id: string; oauth_connection_id: string | null }>(
		`SELECT team_id, oauth_connection_id FROM mcp_connections WHERE id = $1`,
		[id],
	);
	if (existing.rows.length === 0) return err(c, 'NOT_FOUND', 'connector not found', 404);
	if (existing.rows[0].team_id !== teamId)
		return err(c, 'FORBIDDEN', 'connector does not belong to this team', 403);
	const row = await markRevoked(db, id);
	if (existing.rows[0].oauth_connection_id) {
		const { deleteConnection } = await import('../services/oauth/connection-store');
		const masterKeyManager = c.get('masterKeyManager');
		await deleteConnection({ db, masterKeyManager }, existing.rows[0].oauth_connection_id).catch(
			(e) =>
				log.warn('failed to delete oauth_connection on revoke', { error: (e as Error).message }),
		);
	}
	broadcastChange(c, wsRoom.team(teamId), 'mcp_connections', 'UPDATE', {
		id,
		team_id: teamId,
		status: 'revoked',
	});
	return ok(c, row);
});

mcpConnectionsRoutes.post('/teams/:teamId/mcp-connections', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');

	const body = await c.req.json<{
		name: string;
		kind: 'saas' | 'local';
		config: Record<string, unknown>;
		project_id?: string;
		oauth_connection_id?: string | null;
	}>();

	if (!body.name?.trim()) {
		return err(c, 'INVALID_REQUEST', 'name is required', 400);
	}
	if (body.kind !== McpConnectionKind.Saas && body.kind !== McpConnectionKind.Local) {
		return err(c, 'INVALID_REQUEST', 'kind must be "saas" or "local"', 400);
	}
	if (body.kind === McpConnectionKind.Saas) {
		const url = body.config?.url;
		if (typeof url !== 'string' || !url) {
			return err(c, 'INVALID_REQUEST', 'saas connections require config.url (string)', 400);
		}
	} else if (typeof body.config?.command !== 'string' || !body.config.command) {
		return err(c, 'INVALID_REQUEST', 'local connections require config.command (string)', 400);
	}

	if (body.oauth_connection_id) {
		const ownership = await db.query<{ id: string }>(
			`SELECT id FROM oauth_connections WHERE id = $1 AND team_id = $2`,
			[body.oauth_connection_id, teamId],
		);
		if (ownership.rows.length === 0) {
			return err(c, 'NOT_FOUND', 'oauth_connection_id does not belong to this team', 404);
		}
	}

	const initialStatus = body.kind === McpConnectionKind.Saas ? 'installed' : 'pending';
	const result = await db.query(
		`INSERT INTO mcp_connections (team_id, project_id, name, kind, config, oauth_connection_id, install_status)
		 VALUES ($1, $2, $3, $4::mcp_connection_kind, $5::jsonb, $6, $7::mcp_install_status)
		 ON CONFLICT (team_id, project_id, name) DO UPDATE
		 SET kind = EXCLUDED.kind,
		     config = EXCLUDED.config,
		     oauth_connection_id = EXCLUDED.oauth_connection_id,
		     install_status = EXCLUDED.install_status,
		     install_error = NULL,
		     updated_at = now()
		 RETURNING id, team_id, project_id, name, kind::text AS kind,
		           config, oauth_connection_id, install_status::text AS install_status, install_error,
		           created_at, updated_at`,
		[
			teamId,
			body.project_id ?? null,
			body.name.trim(),
			body.kind,
			JSON.stringify(body.config),
			body.oauth_connection_id ?? null,
			initialStatus,
		],
	);

	const inserted = result.rows[0] as Record<string, unknown>;
	broadcastChange(c, wsRoom.team(teamId), 'mcp_connections', 'INSERT', inserted);

	// Kick off install for local MCPs against any running project containers.
	// We don't block the response — the route returns immediately and the
	// install_status flips via broadcast on completion.
	if (body.kind === McpConnectionKind.Local) {
		trackBackground(
			kickoffLocalInstall(c, teamId, body.project_id ?? null, inserted.id as string).catch((e) =>
				log.warn('local mcp install kickoff failed', { error: (e as Error).message }),
			),
		);
	}

	return ok(c, inserted, 201);
});

async function kickoffLocalInstall(
	c: import('hono').Context<Env>,
	teamId: string,
	projectId: string | null,
	rowId: string,
): Promise<void> {
	const db = c.get('db');
	const docker = c.get('docker');

	const candidates = await db.query<{ id: string; container_id: string | null }>(
		`SELECT id, container_id FROM projects
		 WHERE team_id = $1 AND container_id IS NOT NULL AND container_status = 'running'
		   ${projectId ? 'AND id = $2' : ''}`,
		projectId ? [teamId, projectId] : [teamId],
	);

	for (const project of candidates.rows) {
		if (!project.container_id) continue;
		try {
			const result = await installLocalMcpById(
				{ db, docker, containerId: project.container_id, teamId, projectId: project.id },
				rowId,
			);
			if (result) {
				broadcastChange(c, wsRoom.team(teamId), 'mcp_connections', 'UPDATE', {
					id: rowId,
					install_status: result.status,
					install_error: result.error ?? null,
				});
			}
		} catch (e) {
			log.warn('local mcp install per-project failed', {
				project: project.id,
				error: (e as Error).message,
			});
		}
	}
}

/**
 * Idempotently materialize a connector row from the capability registry.
 * Used by the UI's "Connect <provider>" buttons (project settings page,
 * connectors page) so the user never has to manually create the row before
 * starting auth. Same shape as the `register_connector` MCP tool, just
 * keyed on the registry id instead of free-form input.
 */
mcpConnectionsRoutes.post('/teams/:teamId/connectors/ensure', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const body = (await c.req.json().catch(() => ({}))) as { provider_id?: string };
	const providerId = body.provider_id?.trim();
	if (!providerId) return err(c, 'INVALID_REQUEST', 'provider_id is required', 400);
	const capability = getConnectorCapability(providerId);
	if (!capability)
		return err(c, 'NOT_FOUND', `no registered capability for provider_id=${providerId}`, 404);
	if (!capability.mcpServer.url)
		return err(c, 'INVALID_REQUEST', `provider ${providerId} has no MCP server url`, 400);

	const { row, alreadyExisted } = await createOrFetchConnector(db, {
		teamId,
		name: capability.id,
		displayName: capability.displayName,
		mcpUrl: capability.mcpServer.url,
		mcpTransport: capability.mcpServer.transport,
		providerId: capability.id,
	});
	if (!alreadyExisted) {
		broadcastChange(c, wsRoom.team(teamId), 'mcp_connections', 'INSERT', { id: row.id });
	}
	return ok(c, row);
});

mcpConnectionsRoutes.delete('/teams/:teamId/mcp-connections/:id', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const id = c.req.param('id');

	const result = await db.query<{ id: string }>(
		'DELETE FROM mcp_connections WHERE id = $1 AND team_id = $2 RETURNING id',
		[id, teamId],
	);
	if (result.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'MCP connection not found', 404);
	}
	broadcastChange(c, wsRoom.team(teamId), 'mcp_connections', 'DELETE', { id });
	return c.json({ data: null }, 200);
});
