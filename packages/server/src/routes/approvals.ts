import { Hono } from 'hono';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';

export const approvalsRoutes = new Hono<Env>();

approvalsRoutes.get('/companies/:companyId/approvals', async (c) => {
	const db = c.get('db');
	const companyId = c.req.param('companyId');
	const statusFilter = c.req.query('status') || 'pending';

	const result = await db.query(
		`SELECT a.id, a.company_id, a.type, a.status, a.payload, a.resolution_note,
            a.resolved_at, a.created_at,
            co.name AS company_name,
            COALESCE(ma.title, m.display_name) AS requested_by_name,
            a.requested_by_member_id
     FROM approvals a
     JOIN companies co ON co.id = a.company_id
     LEFT JOIN members m ON m.id = a.requested_by_member_id
     LEFT JOIN member_agents ma ON ma.id = a.requested_by_member_id
     WHERE a.company_id = $1 AND a.status IN (${statusFilter
				.split(',')
				.map((_, i) => `$${i + 2}::approval_status`)
				.join(', ')})
     ORDER BY a.created_at DESC`,
		[companyId, ...statusFilter.split(',').map((s) => s.trim())],
	);

	return ok(c, result.rows);
});

approvalsRoutes.post('/companies/:companyId/approvals', async (c) => {
	const db = c.get('db');
	const companyId = c.req.param('companyId');

	const body = await c.req.json<{
		type: string;
		requested_by_member_id: string;
		payload: Record<string, unknown>;
	}>();

	if (!body.type || !body.requested_by_member_id || !body.payload) {
		return err(c, 'INVALID_REQUEST', 'type, requested_by_member_id, and payload are required', 400);
	}

	const result = await db.query(
		`INSERT INTO approvals (company_id, type, requested_by_member_id, payload)
     VALUES ($1, $2::approval_type, $3, $4::jsonb)
     RETURNING *`,
		[companyId, body.type, body.requested_by_member_id, JSON.stringify(body.payload)],
	);

	return ok(c, result.rows[0], 201);
});

approvalsRoutes.post('/approvals/:approvalId/resolve', async (c) => {
	const db = c.get('db');
	const approvalId = c.req.param('approvalId');

	const existing = await db.query<{ status: string }>(
		'SELECT status FROM approvals WHERE id = $1',
		[approvalId],
	);
	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Approval not found', 404);
	}
	if (existing.rows[0].status !== 'pending') {
		return err(c, 'INVALID_STATE', 'Approval is already resolved', 409);
	}

	const body = await c.req.json<{
		status: 'approved' | 'denied';
		resolution_note?: string;
	}>();

	if (!['approved', 'denied'].includes(body.status)) {
		return err(c, 'INVALID_REQUEST', "status must be 'approved' or 'denied'", 400);
	}

	const result = await db.query(
		`UPDATE approvals SET status = $1::approval_status, resolution_note = $2, resolved_at = now()
     WHERE id = $3 RETURNING *`,
		[body.status, body.resolution_note ?? null, approvalId],
	);

	return ok(c, result.rows[0]);
});
