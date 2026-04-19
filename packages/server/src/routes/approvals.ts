import { createHash } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { ApprovalStatus, ApprovalType, wsRoom } from '@hezo/shared';
import { Hono } from 'hono';
import { broadcastChange } from '../lib/broadcast';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { requireCompanyAccess, requireCompanyAccessForResource } from '../middleware/auth';

async function applyApprovalSideEffect(
	db: PGlite,
	approval: Record<string, unknown>,
	dataDir: string,
): Promise<void> {
	const payload = approval.payload as Record<string, unknown>;
	switch (approval.type) {
		case ApprovalType.SystemPromptUpdate: {
			const old = await db.query<{ system_prompt: string }>(
				'SELECT system_prompt FROM member_agents WHERE id = $1',
				[payload.member_id],
			);
			const revNum = await db.query<{ n: number }>(
				'SELECT COALESCE(MAX(revision_number), 0) + 1 AS n FROM system_prompt_revisions WHERE member_agent_id = $1',
				[payload.member_id],
			);
			await db.query('UPDATE member_agents SET system_prompt = $1 WHERE id = $2', [
				payload.new_system_prompt,
				payload.member_id,
			]);
			await db.query(
				`INSERT INTO system_prompt_revisions (member_agent_id, company_id, revision_number, old_prompt, new_prompt, change_summary, author_member_id, approval_id)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
				[
					payload.member_id,
					approval.company_id,
					revNum.rows[0].n,
					old.rows[0]?.system_prompt ?? '',
					payload.new_system_prompt,
					(payload.reason as string) ?? '',
					(payload.requested_by as string) ?? (approval.requested_by_member_id as string) ?? null,
					approval.id,
				],
			);
			break;
		}
		case ApprovalType.SkillProposal: {
			const companyId = approval.company_id as string;
			const slug = payload.skill_slug as string;
			const name = payload.skill_name as string;
			const content = payload.content as string;
			const contentHash = createHash('sha256').update(content).digest('hex');
			const requestedBy =
				(payload.requested_by as string) ?? (approval.requested_by_member_id as string) ?? null;

			// Write to DB (source of truth)
			const skillResult = await db.query<{ id: string }>(
				`INSERT INTO skills (company_id, name, slug, description, content, content_hash, created_by_member_id)
				 VALUES ($1, $2, $3, $4, $5, $6, $7)
				 ON CONFLICT (company_id, slug) DO UPDATE SET
				   content = EXCLUDED.content,
				   content_hash = EXCLUDED.content_hash,
				   updated_at = now()
				 RETURNING id`,
				[
					companyId,
					name,
					slug,
					(payload.reason as string) ?? '',
					content,
					contentHash,
					requestedBy,
				],
			);

			if (skillResult.rows[0]) {
				await db.query(
					`INSERT INTO skill_revisions (skill_id, revision_number, content, content_hash, change_summary, author_member_id)
					 VALUES ($1, (SELECT COALESCE(MAX(revision_number), 0) + 1 FROM skill_revisions WHERE skill_id = $1), $2, $3, 'Created via approval', $4)`,
					[skillResult.rows[0].id, content, contentHash, requestedBy],
				);
			}
			break;
		}
	}
}

export const approvalsRoutes = new Hono<Env>();

approvalsRoutes.get('/companies/:companyId/approvals', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const statusFilter = c.req.query('status') || ApprovalStatus.Pending;

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
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;

	const body = await c.req.json<{
		type: string;
		requested_by_member_id: string;
		payload: Record<string, unknown>;
	}>();

	if (!body.type || !body.payload) {
		return err(c, 'INVALID_REQUEST', 'type and payload are required', 400);
	}

	const result = await db.query(
		`INSERT INTO approvals (company_id, type, requested_by_member_id, payload)
     VALUES ($1, $2::approval_type, $3, $4::jsonb)
     RETURNING *`,
		[companyId, body.type, body.requested_by_member_id, JSON.stringify(body.payload)],
	);

	broadcastChange(
		c,
		wsRoom.company(companyId),
		'approvals',
		'INSERT',
		result.rows[0] as Record<string, unknown>,
	);
	return ok(c, result.rows[0], 201);
});

approvalsRoutes.post('/approvals/:approvalId/resolve', async (c) => {
	const db = c.get('db');
	const approvalId = c.req.param('approvalId');

	const existing = await db.query<{ status: string; company_id: string }>(
		'SELECT status, company_id FROM approvals WHERE id = $1',
		[approvalId],
	);
	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Approval not found', 404);
	}

	const resourceAccess = await requireCompanyAccessForResource(db, c, existing.rows[0].company_id);
	if (resourceAccess instanceof Response) return resourceAccess;

	if (existing.rows[0].status !== ApprovalStatus.Pending) {
		return err(c, 'INVALID_STATE', 'Approval is already resolved', 409);
	}

	const body = await c.req.json<{
		status: 'approved' | 'denied';
		resolution_note?: string;
	}>();

	if (body.status !== ApprovalStatus.Approved && body.status !== ApprovalStatus.Denied) {
		return err(c, 'INVALID_REQUEST', "status must be 'approved' or 'denied'", 400);
	}

	const result = await db.query(
		`UPDATE approvals SET status = $1::approval_status, resolution_note = $2, resolved_at = now()
     WHERE id = $3 RETURNING *`,
		[body.status, body.resolution_note ?? null, approvalId],
	);

	const row = result.rows[0] as Record<string, unknown>;

	if (body.status === ApprovalStatus.Approved) {
		const dataDir = c.get('dataDir');
		await applyApprovalSideEffect(db, row, dataDir);
	}

	if (row.company_id) {
		broadcastChange(c, wsRoom.company(row.company_id as string), 'approvals', 'UPDATE', row);
	}
	return ok(c, row);
});
