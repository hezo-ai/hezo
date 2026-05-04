import { McpConnectionKind, wsRoom } from '@hezo/shared';
import { Hono } from 'hono';
import { broadcastChange } from '../lib/broadcast';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { logger } from '../logger';
import { requireCompanyAccess } from '../middleware/auth';
import { installLocalMcpById } from '../services/mcp-installer';

const log = logger.child('mcp-connections-route');

export const mcpConnectionsRoutes = new Hono<Env>();

mcpConnectionsRoutes.get('/companies/:companyId/mcp-connections', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const projectId = c.req.query('project_id') ?? null;

	const params: unknown[] = [companyId];
	let where = 'company_id = $1';
	if (projectId) {
		where += ' AND (project_id IS NULL OR project_id = $2)';
		params.push(projectId);
	}
	const result = await db.query(
		`SELECT id, company_id, project_id, name, kind::text AS kind,
		        config, oauth_connection_id, install_status::text AS install_status, install_error,
		        created_at, updated_at
		 FROM mcp_connections
		 WHERE ${where}
		 ORDER BY name ASC`,
		params,
	);
	return ok(c, result.rows);
});

mcpConnectionsRoutes.post('/companies/:companyId/mcp-connections', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;

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
			`SELECT id FROM oauth_connections WHERE id = $1 AND company_id = $2`,
			[body.oauth_connection_id, companyId],
		);
		if (ownership.rows.length === 0) {
			return err(c, 'NOT_FOUND', 'oauth_connection_id does not belong to this company', 404);
		}
	}

	const initialStatus = body.kind === McpConnectionKind.Saas ? 'installed' : 'pending';
	const result = await db.query(
		`INSERT INTO mcp_connections (company_id, project_id, name, kind, config, oauth_connection_id, install_status)
		 VALUES ($1, $2, $3, $4::mcp_connection_kind, $5::jsonb, $6, $7::mcp_install_status)
		 ON CONFLICT (company_id, project_id, name) DO UPDATE
		 SET kind = EXCLUDED.kind,
		     config = EXCLUDED.config,
		     oauth_connection_id = EXCLUDED.oauth_connection_id,
		     install_status = EXCLUDED.install_status,
		     install_error = NULL,
		     updated_at = now()
		 RETURNING id, company_id, project_id, name, kind::text AS kind,
		           config, oauth_connection_id, install_status::text AS install_status, install_error,
		           created_at, updated_at`,
		[
			companyId,
			body.project_id ?? null,
			body.name.trim(),
			body.kind,
			JSON.stringify(body.config),
			body.oauth_connection_id ?? null,
			initialStatus,
		],
	);

	const inserted = result.rows[0] as Record<string, unknown>;
	broadcastChange(c, wsRoom.company(companyId), 'mcp_connections', 'INSERT', inserted);

	// Kick off install for local MCPs against any running project containers.
	// We don't block the response — the route returns immediately and the
	// install_status flips via broadcast on completion.
	if (body.kind === McpConnectionKind.Local) {
		void kickoffLocalInstall(c, companyId, body.project_id ?? null, inserted.id as string).catch(
			(e) => log.warn('local mcp install kickoff failed', { error: (e as Error).message }),
		);
	}

	return ok(c, inserted, 201);
});

async function kickoffLocalInstall(
	c: import('hono').Context<Env>,
	companyId: string,
	projectId: string | null,
	rowId: string,
): Promise<void> {
	const db = c.get('db');
	const docker = c.get('docker');

	const candidates = await db.query<{ id: string; container_id: string | null }>(
		`SELECT id, container_id FROM projects
		 WHERE company_id = $1 AND container_id IS NOT NULL AND container_status = 'running'
		   ${projectId ? 'AND id = $2' : ''}`,
		projectId ? [companyId, projectId] : [companyId],
	);

	for (const project of candidates.rows) {
		if (!project.container_id) continue;
		try {
			const result = await installLocalMcpById(
				{ db, docker, containerId: project.container_id, companyId, projectId: project.id },
				rowId,
			);
			if (result) {
				broadcastChange(c, wsRoom.company(companyId), 'mcp_connections', 'UPDATE', {
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

mcpConnectionsRoutes.delete('/companies/:companyId/mcp-connections/:id', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const id = c.req.param('id');

	const result = await db.query<{ id: string }>(
		'DELETE FROM mcp_connections WHERE id = $1 AND company_id = $2 RETURNING id',
		[id, companyId],
	);
	if (result.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'MCP connection not found', 404);
	}
	broadcastChange(c, wsRoom.company(companyId), 'mcp_connections', 'DELETE', { id });
	return c.json({ data: null }, 200);
});
