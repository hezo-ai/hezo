import { getConnectorCapability, McpConnectionKind, wsRoom } from '@hezo/shared';
import { Hono } from 'hono';
import { trackBackground } from '../lib/background';
import { broadcastChange } from '../lib/broadcast';
import { resolveActor } from '../lib/resolve';
import { err, ok } from '../lib/response';
import { isUniqueViolation } from '../lib/sql';
import type { Env } from '../lib/types';
import { logger } from '../logger';
import { requireAdminEquivalent } from '../middleware/auth';
import { createOrFetchConnector } from '../services/connectors/lifecycle';
import { installLocalMcpById } from '../services/mcp-installer';

const log = logger.child('mcp-connections-route');

// Connectors are scoped by project_id (NULL = global "all projects" scope). The
// project-scoped routes below read/write that project's own connectors plus
// global ones; the un-prefixed routes are the Admin (superuser) surface for
// `/settings/connectors`, which spans every project.
const CONNECTOR_COLUMNS = `id, name, display_name, kind::text AS kind,
        config, oauth_connection_id, project_id, install_status::text AS install_status, install_error,
        skill_id, created_by_task_id, activated_at, revoked_at, auth_error,
        created_at, updated_at`;

// Same columns, `mc.`-qualified for queries that JOIN `projects` (whose id/name/
// slug would otherwise collide with the connector's).
const CONNECTOR_COLUMNS_MC = `mc.id, mc.name, mc.display_name, mc.kind::text AS kind,
        mc.config, mc.oauth_connection_id, mc.project_id, mc.install_status::text AS install_status,
        mc.install_error, mc.skill_id, mc.created_by_task_id, mc.activated_at, mc.revoked_at,
        mc.auth_error, mc.created_at, mc.updated_at`;

export const mcpConnectionsRoutes = new Hono<Env>();

mcpConnectionsRoutes.get('/projects/:projectId/mcp-connections', async (c) => {
	const db = c.get('db');
	const projectId = c.get('projectId') as string;
	const result = await db.query(
		`SELECT ${CONNECTOR_COLUMNS_MC}, oc.provider_account_label AS oauth_account_label
		 FROM mcp_connections mc
		 LEFT JOIN oauth_connections oc ON oc.id = mc.oauth_connection_id
		 WHERE mc.project_id = $1 OR mc.project_id IS NULL
		 ORDER BY mc.name ASC`,
		[projectId],
	);
	return ok(c, result.rows);
});

// Admin surface: every connector across all projects, each annotated with its
// owning project (null = global) so `/settings/connectors` can render + filter
// by project.
mcpConnectionsRoutes.get('/mcp-connections', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;
	const db = c.get('db');
	const result = await db.query(
		`SELECT ${CONNECTOR_COLUMNS_MC}, p.name AS project_name, p.slug AS project_slug,
		        oc.provider_account_label AS oauth_account_label
		 FROM mcp_connections mc
		 LEFT JOIN projects p ON p.id = mc.project_id
		 LEFT JOIN oauth_connections oc ON oc.id = mc.oauth_connection_id
		 ORDER BY mc.name ASC`,
	);
	return ok(c, result.rows);
});

mcpConnectionsRoutes.post('/mcp-connections', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;
	const db = c.get('db');

	const body = await c.req.json<{
		name: string;
		display_name?: string;
		kind: 'saas' | 'local';
		config: Record<string, unknown>;
		project_id?: string | null;
	}>();

	if (!body.name?.trim()) {
		return err(c, 'INVALID_REQUEST', 'name is required', 400);
	}
	if (body.kind !== McpConnectionKind.Saas) {
		return err(c, 'INVALID_REQUEST', 'connectors must be "saas" (remote MCP url)', 400);
	}
	const url = body.config?.url;
	if (typeof url !== 'string' || !url) {
		return err(c, 'INVALID_REQUEST', 'saas connections require config.url (string)', 400);
	}

	// The admin surface may target a specific project (from the scope dropdown) or
	// create a global "all projects" connector (project_id null). Validate a named
	// project exists; the superuser may act on any.
	const projectId = body.project_id?.trim() || null;
	if (projectId) {
		const proj = await db.query<{ id: string }>(`SELECT id FROM projects WHERE id = $1`, [
			projectId,
		]);
		if (proj.rows.length === 0) return err(c, 'NOT_FOUND', 'project_id not found', 404);
	}

	// Re-adding an existing name in the same scope is a reconfiguration: config is
	// replaced wholesale (dropping any stale config.dcr for a changed URL) and a
	// previous OAuth attempt's auth_error is cleared, so the row starts from a
	// clean slate. An active row keeps oauth_connection_id/activated_at. The
	// conflict target names the partial unique index matching the row's scope.
	const conflictTarget = projectId
		? '(project_id, name) WHERE project_id IS NOT NULL'
		: '(name) WHERE project_id IS NULL';
	const result = await db.query(
		`INSERT INTO mcp_connections (name, display_name, kind, config, install_status, project_id)
		 VALUES ($1, $2, $3::mcp_connection_kind, $4::jsonb, 'installed'::mcp_install_status, $5)
		 ON CONFLICT ${conflictTarget} DO UPDATE
		 SET display_name = EXCLUDED.display_name,
		     kind = EXCLUDED.kind,
		     config = EXCLUDED.config,
		     install_status = EXCLUDED.install_status,
		     install_error = NULL,
		     auth_error = NULL,
		     updated_at = now()
		 RETURNING ${CONNECTOR_COLUMNS}`,
		[
			body.name.trim(),
			body.display_name?.trim() ?? null,
			body.kind,
			JSON.stringify(body.config),
			projectId,
		],
	);

	const createdRow = result.rows[0] as { id: string; name: string };
	c.get('events').emit({
		type: 'mcp_connection.created',
		teamId: null,
		actorType: 'admin',
		actorMemberId: null,
		connectionId: createdRow.id,
		name: createdRow.name,
	});
	return ok(c, result.rows[0], 201);
});

// Admin surface: re-scope a connector to a different project (or to the global
// "all projects" scope, project_id null). Only the scope is editable here — the
// per-row inline scope picker on `/settings/connectors` posts to this.
mcpConnectionsRoutes.patch('/mcp-connections/:id', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;
	const db = c.get('db');
	const id = c.req.param('id');

	const body = await c.req
		.json<{ project_id?: string | null }>()
		.catch(() => ({}) as { project_id?: string | null });
	if (!('project_id' in body)) {
		return err(c, 'INVALID_REQUEST', 'project_id is required', 400);
	}
	// Empty/whitespace collapses to the global scope (project_id null).
	const projectId = body.project_id?.trim() || null;
	if (projectId) {
		const proj = await db.query<{ id: string }>(`SELECT id FROM projects WHERE id = $1`, [
			projectId,
		]);
		if (proj.rows.length === 0) return err(c, 'NOT_FOUND', 'project_id not found', 404);
	}

	let result: Awaited<ReturnType<typeof db.query>>;
	try {
		result = await db.query(
			`UPDATE mcp_connections SET project_id = $2, updated_at = now()
			 WHERE id = $1
			 RETURNING ${CONNECTOR_COLUMNS},
			   (SELECT name FROM projects WHERE id = project_id) AS project_name,
			   (SELECT slug FROM projects WHERE id = project_id) AS project_slug`,
			[id, projectId],
		);
	} catch (e) {
		// Moving into a scope that already holds a connector of the same name trips
		// one of the partial unique indexes (global name / per-project name).
		if (isUniqueViolation(e)) {
			return err(
				c,
				'CONFLICT',
				'a connector with this name already exists in the target scope',
				409,
			);
		}
		throw e;
	}
	if (result.rows.length === 0) return err(c, 'NOT_FOUND', 'connector not found', 404);

	const updated = result.rows[0] as { id: string; name: string };
	c.get('events').emit({
		type: 'mcp_connection.updated',
		teamId: null,
		actorType: 'admin',
		actorMemberId: null,
		connectionId: updated.id,
		name: updated.name,
		changeKind: 'scope',
	});
	return ok(c, result.rows[0]);
});

mcpConnectionsRoutes.delete('/mcp-connections/:id', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;
	const db = c.get('db');
	const id = c.req.param('id');
	const result = await db.query<{ id: string; name: string }>(
		'DELETE FROM mcp_connections WHERE id = $1 RETURNING id, name',
		[id],
	);
	if (result.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'connector not found', 404);
	}
	c.get('events').emit({
		type: 'mcp_connection.deleted',
		teamId: null,
		actorType: 'admin',
		actorMemberId: null,
		connectionId: result.rows[0].id,
		name: result.rows[0].name,
	});
	return c.json({ data: null }, 200);
});

mcpConnectionsRoutes.get('/projects/:projectId/mcp-connections/:id', async (c) => {
	const db = c.get('db');
	const projectId = c.get('projectId') as string;
	const id = c.req.param('id');
	const result = await db.query(
		`SELECT ${CONNECTOR_COLUMNS} FROM mcp_connections
		 WHERE id = $1 AND (project_id = $2 OR project_id IS NULL)`,
		[id, projectId],
	);
	if (result.rows.length === 0) return err(c, 'NOT_FOUND', 'connector not found', 404);
	return ok(c, result.rows[0]);
});

mcpConnectionsRoutes.post('/projects/:projectId/mcp-connections/:id/revoke', async (c) => {
	const teamId = c.get('teamId') as string;
	const projectId = c.get('projectId') as string;
	const db = c.get('db');
	const id = c.req.param('id');
	const { markRevoked } = await import('../services/connectors/lifecycle');
	const existing = await db.query<{
		name: string;
		oauth_connection_id: string | null;
	}>(
		`SELECT name, oauth_connection_id FROM mcp_connections
		 WHERE id = $1 AND (project_id = $2 OR project_id IS NULL)`,
		[id, projectId],
	);
	if (existing.rows.length === 0) return err(c, 'NOT_FOUND', 'connector not found', 404);
	const row = await markRevoked(db, id);
	if (existing.rows[0].oauth_connection_id) {
		const { deleteConnection } = await import('../services/oauth/connection-store');
		const masterKeyManager = c.get('masterKeyManager');
		const oauthConnectionId = existing.rows[0].oauth_connection_id;
		await deleteConnection({ db, masterKeyManager }, oauthConnectionId)
			.then(() => {
				const a = resolveActor(db, c.get('auth'), teamId);
				return a.then((actor) =>
					c.get('events').emit({
						type: 'connection.deleted',
						teamId,
						actorType: actor.actorType,
						actorMemberId: actor.actorMemberId,
						connectionId: oauthConnectionId,
						provider: existing.rows[0].name,
					}),
				);
			})
			.catch((e) =>
				log.warn('failed to delete oauth_connection on revoke', { error: (e as Error).message }),
			);
	}
	broadcastChange(c, wsRoom.team(teamId), 'mcp_connections', 'UPDATE', {
		id,
		status: 'revoked',
	});
	const revokeActor = await resolveActor(db, c.get('auth'), teamId);
	c.get('events').emit({
		type: 'mcp_connection.updated',
		teamId,
		actorType: revokeActor.actorType,
		actorMemberId: revokeActor.actorMemberId,
		connectionId: id,
		name: existing.rows[0].name,
		changeKind: 'revoked',
	});
	return ok(c, row);
});

mcpConnectionsRoutes.post('/projects/:projectId/mcp-connections', async (c) => {
	const teamId = c.get('teamId') as string;
	const projectId = c.get('projectId') as string;
	const db = c.get('db');

	const body = await c.req.json<{
		name: string;
		kind: 'saas' | 'local';
		config: Record<string, unknown>;
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
		// Only an oauth connection visible to this project (its own or global) may
		// be linked — never another project's.
		const ownership = await db.query<{ id: string }>(
			`SELECT id FROM oauth_connections
			 WHERE id = $1 AND (project_id = $2 OR project_id IS NULL)`,
			[body.oauth_connection_id, projectId],
		);
		if (ownership.rows.length === 0) {
			return err(c, 'NOT_FOUND', 'oauth_connection_id not found', 404);
		}
	}

	const initialStatus = body.kind === McpConnectionKind.Saas ? 'installed' : 'pending';
	const result = await db.query(
		`INSERT INTO mcp_connections (name, kind, config, oauth_connection_id, install_status, project_id)
		 VALUES ($1, $2::mcp_connection_kind, $3::jsonb, $4, $5::mcp_install_status, $6)
		 ON CONFLICT (project_id, name) WHERE project_id IS NOT NULL DO UPDATE
		 SET kind = EXCLUDED.kind,
		     config = EXCLUDED.config,
		     oauth_connection_id = EXCLUDED.oauth_connection_id,
		     install_status = EXCLUDED.install_status,
		     install_error = NULL,
		     updated_at = now()
		 RETURNING ${CONNECTOR_COLUMNS}`,
		[
			body.name.trim(),
			body.kind,
			JSON.stringify(body.config),
			body.oauth_connection_id ?? null,
			initialStatus,
			projectId,
		],
	);

	const inserted = result.rows[0] as Record<string, unknown>;
	broadcastChange(c, wsRoom.team(teamId), 'mcp_connections', 'INSERT', inserted);

	const createActor = await resolveActor(db, c.get('auth'), teamId);
	c.get('events').emit({
		type: 'mcp_connection.created',
		teamId,
		actorType: createActor.actorType,
		actorMemberId: createActor.actorMemberId,
		connectionId: inserted.id as string,
		name: inserted.name as string,
	});

	// Kick off install for local MCPs against any running container of the
	// team that created it. install_status is advisory under a global catalog.
	if (body.kind === McpConnectionKind.Local) {
		trackBackground(
			kickoffLocalInstall(c, teamId, inserted.id as string).catch((e) =>
				log.warn('local mcp install kickoff failed', { error: (e as Error).message }),
			),
		);
	}

	return ok(c, inserted, 201);
});

async function kickoffLocalInstall(
	c: import('hono').Context<Env>,
	teamId: string,
	rowId: string,
): Promise<void> {
	const db = c.get('db');
	const docker = c.get('docker');

	const candidates = await db.query<{ id: string; container_id: string | null }>(
		`SELECT id, container_id FROM projects
		 WHERE team_id = $1 AND container_id IS NOT NULL AND container_status = 'running'`,
		[teamId],
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
mcpConnectionsRoutes.post('/projects/:projectId/connectors/ensure', async (c) => {
	const teamId = c.get('teamId') as string;
	const projectId = c.get('projectId') as string;
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
		name: capability.id,
		displayName: capability.displayName,
		mcpUrl: capability.mcpServer.url,
		mcpTransport: capability.mcpServer.transport,
		mcpHeaders: capability.mcpServer.headers,
		providerId: capability.id,
		projectId,
	});
	if (!alreadyExisted) {
		broadcastChange(c, wsRoom.team(teamId), 'mcp_connections', 'INSERT', { id: row.id });
		const ensureActor = await resolveActor(db, c.get('auth'), teamId);
		c.get('events').emit({
			type: 'mcp_connection.created',
			teamId,
			actorType: ensureActor.actorType,
			actorMemberId: ensureActor.actorMemberId,
			connectionId: row.id as string,
			name: row.name as string,
		});
	}
	return ok(c, row);
});

mcpConnectionsRoutes.delete('/projects/:projectId/mcp-connections/:id', async (c) => {
	const teamId = c.get('teamId') as string;
	const projectId = c.get('projectId') as string;
	const db = c.get('db');
	const id = c.req.param('id');

	// A project may only delete its own connectors, never a global or another
	// project's.
	const result = await db.query<{ id: string; name: string }>(
		'DELETE FROM mcp_connections WHERE id = $1 AND project_id = $2 RETURNING id, name',
		[id, projectId],
	);
	if (result.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'MCP connection not found', 404);
	}
	broadcastChange(c, wsRoom.team(teamId), 'mcp_connections', 'DELETE', { id });
	const deleteActor = await resolveActor(db, c.get('auth'), teamId);
	c.get('events').emit({
		type: 'mcp_connection.deleted',
		teamId,
		actorType: deleteActor.actorType,
		actorMemberId: deleteActor.actorMemberId,
		connectionId: result.rows[0].id,
		name: result.rows[0].name,
	});
	return c.json({ data: null }, 200);
});
