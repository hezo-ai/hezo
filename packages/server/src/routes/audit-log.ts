import { Hono } from 'hono';
import { buildMeta, parsePagination } from '../lib/pagination';
import type { Env } from '../lib/types';
import { listTeamAuditLog } from '../repositories/audit-log';

export const auditLogRoutes = new Hono<Env>();

auditLogRoutes.get('/teams/:teamId/audit-log', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const { page, perPage, offset } = parsePagination(c);

	const { rows, total } = await listTeamAuditLog(
		db,
		{
			teamId,
			entityType: c.req.query('entity_type'),
			action: c.req.query('action'),
			from: c.req.query('from'),
			to: c.req.query('to'),
		},
		{ perPage, offset },
	);

	return c.json({ data: rows, meta: buildMeta(page, perPage, total) });
});
