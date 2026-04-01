import { Hono } from 'hono';
import { buildMeta, parsePagination } from '../lib/pagination';
import type { Env } from '../lib/types';

export const auditLogRoutes = new Hono<Env>();

auditLogRoutes.get('/companies/:companyId/audit-log', async (c) => {
	const db = c.get('db');
	const companyId = c.req.param('companyId');
	const { page, perPage, offset } = parsePagination(c);

	const conditions: string[] = ['al.company_id = $1'];
	const params: unknown[] = [companyId];
	let idx = 2;

	const entityType = c.req.query('entity_type');
	if (entityType) {
		conditions.push(`al.entity_type = $${idx}`);
		params.push(entityType);
		idx++;
	}

	const action = c.req.query('action');
	if (action) {
		conditions.push(`al.action = $${idx}`);
		params.push(action);
		idx++;
	}

	const from = c.req.query('from');
	if (from) {
		conditions.push(`al.created_at >= $${idx}`);
		params.push(from);
		idx++;
	}

	const to = c.req.query('to');
	if (to) {
		conditions.push(`al.created_at <= $${idx}`);
		params.push(to);
		idx++;
	}

	const where = conditions.join(' AND ');

	const countResult = await db.query<{ count: number }>(
		`SELECT count(*)::int AS count FROM audit_log al WHERE ${where}`,
		params,
	);
	const total = countResult.rows[0].count;

	const dataParams = [...params, perPage, offset];
	const result = await db.query(
		`SELECT al.id, al.company_id, al.actor_type, al.actor_member_id,
		        al.action, al.entity_type, al.entity_id, al.details, al.created_at,
		        COALESCE(ma.title, m.display_name) AS actor_name
		 FROM audit_log al
		 LEFT JOIN members m ON m.id = al.actor_member_id
		 LEFT JOIN member_agents ma ON ma.id = al.actor_member_id
		 WHERE ${where}
		 ORDER BY al.created_at DESC
		 LIMIT $${idx} OFFSET $${idx + 1}`,
		dataParams,
	);

	return c.json({ data: result.rows, meta: buildMeta(page, perPage, total) });
});
