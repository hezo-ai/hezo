import { McpConnectionKind, wsRoom } from '@hezo/shared';
import { Hono } from 'hono';
import { broadcastChange } from '../lib/broadcast';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { requireCompanyAccess } from '../middleware/auth';

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
		        config, install_status::text AS install_status, install_error,
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

	const initialStatus = body.kind === McpConnectionKind.Saas ? 'installed' : 'pending';
	const result = await db.query(
		`INSERT INTO mcp_connections (company_id, project_id, name, kind, config, install_status)
		 VALUES ($1, $2, $3, $4::mcp_connection_kind, $5::jsonb, $6::mcp_install_status)
		 ON CONFLICT (company_id, project_id, name) DO UPDATE
		 SET kind = EXCLUDED.kind,
		     config = EXCLUDED.config,
		     install_status = EXCLUDED.install_status,
		     install_error = NULL,
		     updated_at = now()
		 RETURNING id, company_id, project_id, name, kind::text AS kind,
		           config, install_status::text AS install_status, install_error,
		           created_at, updated_at`,
		[
			companyId,
			body.project_id ?? null,
			body.name.trim(),
			body.kind,
			JSON.stringify(body.config),
			initialStatus,
		],
	);

	broadcastChange(
		c,
		wsRoom.company(companyId),
		'mcp_connections',
		'INSERT',
		result.rows[0] as Record<string, unknown>,
	);
	return ok(c, result.rows[0], 201);
});

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
