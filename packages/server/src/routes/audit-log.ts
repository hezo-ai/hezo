import type { PGlite } from '@electric-sql/pglite';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { buildMeta, parsePagination } from '../lib/pagination';
import type { Env } from '../lib/types';
import { requireSuperuser } from '../middleware/auth';
import { type AuditLogScope, listAuditLog } from '../repositories/audit-log';

export const auditLogRoutes = new Hono<Env>();

/**
 * Shared reader for the audit log. `scope` pins the base WHERE clause:
 * - team:     `team_id = :id` (with optional ?project_id= filter)
 * - project:  `project_id = :id`
 * - instance: no scope filter (every team + instance-level rows)
 * All three accept the same entity_type / action / from / to filters.
 */
async function queryAuditLog(c: Context<Env>, db: PGlite, scope: AuditLogScope): Promise<Response> {
	const { page, perPage, offset } = parsePagination(c);

	const { rows, total } = await listAuditLog(
		db,
		scope,
		{
			entityType: c.req.query('entity_type'),
			action: c.req.query('action'),
			from: c.req.query('from'),
			to: c.req.query('to'),
		},
		{ perPage, offset },
	);

	return c.json({ data: rows, meta: buildMeta(page, perPage, total) });
}

// Team-scoped view (the project's backing team). Optional ?project_id= narrows it.
auditLogRoutes.get('/projects/:projectId/team-audit-log', async (c) => {
	const teamId = c.get('teamId') as string;
	return queryAuditLog(c, c.get('db'), {
		kind: 'team',
		teamId,
		projectId: c.req.query('project_id') || undefined,
	});
});

// Per-project view — a filtered slice of the instance log scoped to the project.
auditLogRoutes.get('/projects/:projectId/audit-log', async (c) => {
	const projectId = c.get('projectId') as string;
	return queryAuditLog(c, c.get('db'), { kind: 'project', projectId });
});

// Instance-level view — every team + instance-scoped rows. Superuser only.
auditLogRoutes.get('/audit-log', async (c) => {
	const denied = requireSuperuser(c);
	if (denied) return denied;
	return queryAuditLog(c, c.get('db'), { kind: 'instance' });
});
