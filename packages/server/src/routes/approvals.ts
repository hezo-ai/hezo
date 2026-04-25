import { createHash } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import {
	AgentAdminStatus,
	ApprovalStatus,
	ApprovalType,
	DocumentType,
	IssueStatus,
	MemberType,
	wsRoom,
} from '@hezo/shared';
import { Hono } from 'hono';
import { broadcastChange } from '../lib/broadcast';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { logger } from '../logger';
import { requireCompanyAccess, requireCompanyAccessForResource } from '../middleware/auth';
import { enqueueAgentSummaryTask, enqueueTeamSummaryTask } from '../services/description-tasks';
import { upsertDocument } from '../services/documents';

const log = logger.child('approvals');

interface SideEffectBroadcast {
	table: string;
	op: 'INSERT' | 'UPDATE';
	row: Record<string, unknown>;
}

async function applyApprovalSideEffect(
	db: PGlite,
	approval: Record<string, unknown>,
	_dataDir: string,
): Promise<SideEffectBroadcast[]> {
	const payload = approval.payload as Record<string, unknown>;
	const broadcasts: SideEffectBroadcast[] = [];
	switch (approval.type) {
		case ApprovalType.Hire: {
			const companyId = approval.company_id as string;
			const title = (payload.title as string)?.trim();
			const slug = payload.slug as string;
			if (!title || !slug) {
				throw new Error('hire approval payload missing title/slug');
			}

			const slugCheck = await db.query(
				`SELECT ma.id FROM member_agents ma
				 JOIN members m ON m.id = ma.id
				 WHERE m.company_id = $1 AND ma.slug = $2`,
				[companyId, slug],
			);
			if (slugCheck.rows.length > 0) {
				throw new Error(`cannot materialise hire: slug '${slug}' already exists in this company`);
			}

			const memberResult = await db.query<{ id: string }>(
				`INSERT INTO members (company_id, member_type, display_name)
				 VALUES ($1, $2, $3) RETURNING id`,
				[companyId, MemberType.Agent, title],
			);
			const memberId = memberResult.rows[0].id;

			await db.query(
				`INSERT INTO member_agents (id, title, slug, role_description,
				                            default_effort, heartbeat_interval_min,
				                            monthly_budget_cents, touches_code, admin_status)
				 VALUES ($1, $2, $3, $4, $5::agent_effort, $6, $7, $8, $9::agent_admin_status)`,
				[
					memberId,
					title,
					slug,
					(payload.role_description as string) ?? '',
					(payload.default_effort as string) ?? 'medium',
					(payload.heartbeat_interval_min as number) ?? 60,
					(payload.monthly_budget_cents as number) ?? 3000,
					(payload.touches_code as boolean) ?? false,
					AgentAdminStatus.Enabled,
				],
			);

			const promptDoc = await upsertDocument(db, undefined, {
				scope: {
					type: DocumentType.AgentSystemPrompt,
					companyId,
					memberAgentId: memberId,
				},
				content: (payload.system_prompt as string) ?? '',
				changeSummary: 'Initial system prompt',
				authorMemberId: (approval.requested_by_member_id as string) ?? null,
			});
			broadcasts.push({
				table: 'documents',
				op: 'INSERT',
				row: promptDoc as unknown as Record<string, unknown>,
			});

			if (payload.issue_id) {
				const issueUpdate = await db.query<Record<string, unknown>>(
					`UPDATE issues SET status = $1::issue_status, updated_at = now()
					 WHERE id = $2 RETURNING *`,
					[IssueStatus.Done, payload.issue_id as string],
				);
				if (issueUpdate.rows[0]) {
					broadcasts.push({ table: 'issues', op: 'UPDATE', row: issueUpdate.rows[0] });
				}
			}

			const newAgent = await db.query<Record<string, unknown>>(
				`SELECT m.id, m.company_id, m.display_name, m.created_at,
				        ma.agent_type_id, ma.title, ma.slug, ma.role_description, ma.summary,
				        ma.default_effort, ma.heartbeat_interval_min,
				        ma.monthly_budget_cents, ma.budget_used_cents, ma.touches_code,
				        ma.budget_reset_at, ma.runtime_status, ma.admin_status,
				        ma.last_heartbeat_at, ma.reports_to, ma.mcp_servers, ma.updated_at
				 FROM members m JOIN member_agents ma ON ma.id = m.id WHERE m.id = $1`,
				[memberId],
			);
			if (newAgent.rows[0]) {
				broadcasts.push({ table: 'member_agents', op: 'INSERT', row: newAgent.rows[0] });
			}

			enqueueAgentSummaryTask(db, companyId, memberId, 'created').catch((e) =>
				log.error('Failed to enqueue agent summary task:', e),
			);
			enqueueTeamSummaryTask(db, companyId, 'agent_added').catch((e) =>
				log.error('Failed to enqueue team summary task:', e),
			);
			break;
		}
		case ApprovalType.KbUpdate: {
			const slug = payload.slug as string;
			const requestedBy = (approval.requested_by_member_id as string) ?? null;
			const doc = await upsertDocument(db, undefined, {
				scope: {
					type: DocumentType.KbDoc,
					companyId: approval.company_id as string,
					slug,
				},
				title: typeof payload.title === 'string' ? payload.title : undefined,
				content: typeof payload.content === 'string' ? payload.content : '',
				changeSummary: (payload.change_summary as string) ?? '',
				authorMemberId: requestedBy,
			});
			broadcasts.push({
				table: 'documents',
				op: 'UPDATE',
				row: doc as unknown as Record<string, unknown>,
			});
			break;
		}
		case ApprovalType.Strategy: {
			if (
				typeof payload.action === 'string' &&
				payload.action === 'update_prd' &&
				typeof payload.filename === 'string' &&
				typeof payload.content === 'string' &&
				typeof payload.project_id === 'string'
			) {
				const requestedBy = (approval.requested_by_member_id as string) ?? null;
				const doc = await upsertDocument(db, undefined, {
					scope: {
						type: DocumentType.ProjectDoc,
						companyId: approval.company_id as string,
						projectId: payload.project_id,
						slug: payload.filename,
					},
					content: payload.content,
					authorMemberId: requestedBy,
				});
				broadcasts.push({
					table: 'documents',
					op: 'UPDATE',
					row: doc as unknown as Record<string, unknown>,
				});
			}
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
	return broadcasts;
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
            co.slug AS company_slug,
            COALESCE(ma.title, m.display_name) AS requested_by_name,
            a.requested_by_member_id,
            COALESCE(pma.title, pm.display_name) AS payload_member_name,
            pma.slug AS payload_member_slug,
            pp.name AS payload_project_name,
            pp.slug AS payload_project_slug,
            pi.identifier AS payload_issue_identifier
     FROM approvals a
     JOIN companies co ON co.id = a.company_id
     LEFT JOIN members m ON m.id = a.requested_by_member_id
     LEFT JOIN member_agents ma ON ma.id = a.requested_by_member_id
     LEFT JOIN members pm ON pm.id = (a.payload->>'member_id')::uuid
     LEFT JOIN member_agents pma ON pma.id = pm.id
     LEFT JOIN projects pp ON pp.id = (a.payload->>'project_id')::uuid
     LEFT JOIN issues pi ON pi.id = (a.payload->>'issue_id')::uuid
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
	let sideEffects: SideEffectBroadcast[] = [];

	if (body.status === ApprovalStatus.Approved) {
		const dataDir = c.get('dataDir');
		sideEffects = await applyApprovalSideEffect(db, row, dataDir);
	}

	if (row.company_id) {
		const room = wsRoom.company(row.company_id as string);
		broadcastChange(c, room, 'approvals', 'UPDATE', row);
		for (const effect of sideEffects) {
			broadcastChange(c, room, effect.table, effect.op, effect.row);
		}
	}
	return ok(c, row);
});
