import type { PGlite } from '@electric-sql/pglite';
import {
	AgentAdminStatus,
	AuditAction,
	AuditActorType,
	AuditEntityType,
	AuthType,
	IssuePriority,
	IssueStatus,
	WakeupSource,
} from '@hezo/shared';
import { Hono } from 'hono';
import { auditLog } from '../lib/audit';
import { broadcastChange } from '../lib/broadcast';
import { buildMeta, parsePagination } from '../lib/pagination';
import { resolveProjectId } from '../lib/resolve';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { requireCompanyAccess } from '../middleware/auth';
import { createWakeup } from '../services/wakeup';

async function wakeAgentIfAssigned(
	db: PGlite,
	assigneeId: string | null | undefined,
	companyId: string,
	issueId: string,
): Promise<void> {
	if (!assigneeId) return;
	const isAgent = await db.query('SELECT id FROM member_agents WHERE id = $1', [assigneeId]);
	if (isAgent.rows.length > 0) {
		createWakeup(db, assigneeId, companyId, WakeupSource.Assignment, {
			issue_id: issueId,
		}).catch((e) => console.error('[wakeup] Failed to create wakeup for assignment:', e));
	}
}

export const issuesRoutes = new Hono<Env>();

issuesRoutes.get('/companies/:companyId/issues', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const { page, perPage, offset } = parsePagination(c);

	const conditions: string[] = ['i.company_id = $1'];
	const params: unknown[] = [companyId];
	let idx = 2;

	const rawProjectId = c.req.query('project_id');
	if (rawProjectId) {
		const projectId = await resolveProjectId(db, companyId, rawProjectId);
		if (projectId) {
			conditions.push(`i.project_id = $${idx}`);
			params.push(projectId);
			idx++;
		}
	}

	const assigneeId = c.req.query('assignee_id');
	if (assigneeId) {
		conditions.push(`i.assignee_id = $${idx}`);
		params.push(assigneeId);
		idx++;
	}

	const statusFilter = c.req.query('status');
	if (statusFilter) {
		const statuses = statusFilter.split(',').map((s) => s.trim());
		const placeholders = statuses.map((_, i) => `$${idx + i}::issue_status`).join(', ');
		conditions.push(`i.status IN (${placeholders})`);
		params.push(...statuses);
		idx += statuses.length;
	}

	const priorityFilter = c.req.query('priority');
	if (priorityFilter) {
		const priorities = priorityFilter.split(',').map((s) => s.trim());
		const placeholders = priorities.map((_, i) => `$${idx + i}::issue_priority`).join(', ');
		conditions.push(`i.priority IN (${placeholders})`);
		params.push(...priorities);
		idx += priorities.length;
	}

	const search = c.req.query('search');
	if (search) {
		conditions.push(`(i.title ILIKE $${idx} OR i.description ILIKE $${idx})`);
		params.push(`%${search}%`);
		idx++;
	}

	const where = conditions.join(' AND ');

	const sortParam = c.req.query('sort') || 'created_at:desc';
	const [sortField, sortDir] = sortParam.split(':');
	const allowedSorts = ['created_at', 'updated_at', 'priority', 'number'];
	const sortColumn = allowedSorts.includes(sortField) ? sortField : 'created_at';
	const sortDirection = sortDir === 'asc' ? 'ASC' : 'DESC';

	const countResult = await db.query<{ count: number }>(
		`SELECT count(*)::int AS count FROM issues i WHERE ${where}`,
		params,
	);
	const total = countResult.rows[0].count;

	const dataParams = [...params, perPage, offset];
	const result = await db.query(
		`SELECT i.id, i.company_id, i.project_id, i.assignee_id, i.parent_issue_id,
            i.number, i.identifier, i.title, i.description, i.status, i.priority,
            i.labels, i.created_at, i.updated_at,
            p.name AS project_name,
            COALESCE(ma.title, m.display_name) AS assignee_name
     FROM issues i
     JOIN projects p ON p.id = i.project_id
     LEFT JOIN members m ON m.id = i.assignee_id
     LEFT JOIN member_agents ma ON ma.id = i.assignee_id
     WHERE ${where}
     ORDER BY i.${sortColumn} ${sortDirection}
     LIMIT $${idx} OFFSET $${idx + 1}`,
		dataParams,
	);

	return c.json({ data: result.rows, meta: buildMeta(page, perPage, total) });
});

issuesRoutes.post('/companies/:companyId/issues', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;

	const body = await c.req.json<{
		project_id: string;
		title: string;
		description?: string;
		assignee_id?: string;
		parent_issue_id?: string;
		priority?: string;
		labels?: string[];
	}>();

	if (!body.project_id || !body.title?.trim()) {
		return err(c, 'INVALID_REQUEST', 'project_id and title are required', 400);
	}
	if (!body.assignee_id) {
		return err(c, 'INVALID_REQUEST', 'assignee_id is required', 400);
	}

	const companyResult = await db.query<{ issue_prefix: string }>(
		'SELECT issue_prefix FROM companies WHERE id = $1',
		[companyId],
	);
	if (companyResult.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Company not found', 404);
	}

	const numberResult = await db.query<{ number: number }>(
		'SELECT next_issue_number($1) AS number',
		[companyId],
	);
	const issueNumber = numberResult.rows[0].number;
	const identifier = `${companyResult.rows[0].issue_prefix}-${issueNumber}`;

	const result = await db.query(
		`INSERT INTO issues (company_id, project_id, assignee_id, parent_issue_id,
                         number, identifier, title, description, status, priority, labels)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::issue_status, $10::issue_priority, $11::jsonb)
     RETURNING *`,
		[
			companyId,
			body.project_id,
			body.assignee_id ?? null,
			body.parent_issue_id ?? null,
			issueNumber,
			identifier,
			body.title.trim(),
			body.description ?? '',
			IssueStatus.Backlog,
			body.priority ?? IssuePriority.Medium,
			JSON.stringify(body.labels ?? []),
		],
	);

	const issue = result.rows[0] as Record<string, unknown>;

	if (body.assignee_id) {
		const isAgent = await db.query('SELECT id FROM member_agents WHERE id = $1', [
			body.assignee_id,
		]);
		if (isAgent.rows.length > 0) {
			createWakeup(db, body.assignee_id, companyId, WakeupSource.Assignment, {
				issue_id: issue.id as string,
			}).catch((e) => console.error('Failed to create wakeup:', e));
		}
	}

	broadcastChange(c, `company:${companyId}`, 'issues', 'INSERT', issue);
	auditLog(
		db,
		companyId,
		AuditActorType.Board,
		null,
		AuditAction.Created,
		AuditEntityType.Issue,
		issue.id as string,
		{
			identifier,
		},
	).catch(() => {});
	wakeAgentIfAssigned(db, body.assignee_id, companyId, issue.id as string);
	return ok(c, issue, 201);
});

issuesRoutes.get('/companies/:companyId/issues/:issueId', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;

	const result = await db.query(
		`SELECT i.*,
            p.name AS project_name, p.goal AS project_goal,
            co.description AS company_description,
            COALESCE(ma.title, m.display_name) AS assignee_name,
            COALESCE(ma_ps.title, m_ps.display_name) AS progress_summary_updated_by_name,
            (SELECT count(*)::int FROM issue_comments ic WHERE ic.issue_id = i.id) AS comment_count,
            (SELECT COALESCE(sum(ce.amount_cents), 0)::int FROM cost_entries ce WHERE ce.issue_id = i.id) AS cost_cents
     FROM issues i
     JOIN projects p ON p.id = i.project_id
     JOIN companies co ON co.id = i.company_id
     LEFT JOIN members m ON m.id = i.assignee_id
     LEFT JOIN member_agents ma ON ma.id = i.assignee_id
     LEFT JOIN members m_ps ON m_ps.id = i.progress_summary_updated_by
     LEFT JOIN member_agents ma_ps ON ma_ps.id = i.progress_summary_updated_by
     WHERE i.id = $1 AND i.company_id = $2`,
		[c.req.param('issueId'), companyId],
	);

	if (result.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Issue not found', 404);
	}

	return ok(c, result.rows[0]);
});

issuesRoutes.patch('/companies/:companyId/issues/:issueId', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const issueId = c.req.param('issueId');

	const existing = await db.query(
		'SELECT id, status FROM issues WHERE id = $1 AND company_id = $2',
		[issueId, companyId],
	);
	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Issue not found', 404);
	}

	const body = await c.req.json<{
		title?: string;
		description?: string;
		status?: string;
		priority?: string;
		assignee_id?: string | null;
		labels?: string[];
		progress_summary?: string | null;
		rules?: string | null;
	}>();

	const sets: string[] = [];
	const params: unknown[] = [];
	let idx = 1;

	if (body.title?.trim() !== undefined) {
		sets.push(`title = $${idx}`);
		params.push(body.title.trim());
		idx++;
	}
	if (body.description !== undefined) {
		sets.push(`description = $${idx}`);
		params.push(body.description);
		idx++;
	}
	if (body.status !== undefined) {
		sets.push(`status = $${idx}::issue_status`);
		params.push(body.status);
		idx++;
	}
	if (body.priority !== undefined) {
		sets.push(`priority = $${idx}::issue_priority`);
		params.push(body.priority);
		idx++;
	}
	if (body.assignee_id !== undefined) {
		if (body.assignee_id === null) {
			return err(c, 'INVALID_REQUEST', 'assignee_id cannot be null', 400);
		}
		sets.push(`assignee_id = $${idx}`);
		params.push(body.assignee_id);
		idx++;
	}
	if (body.labels !== undefined) {
		sets.push(`labels = $${idx}::jsonb`);
		params.push(JSON.stringify(body.labels));
		idx++;
	}
	if (body.progress_summary !== undefined) {
		sets.push(`progress_summary = $${idx}`);
		params.push(body.progress_summary);
		idx++;
		sets.push('progress_summary_updated_at = now()');
		const auth = c.get('auth');
		const updatedBy = auth.type === AuthType.Agent ? auth.memberId : null;
		sets.push(`progress_summary_updated_by = $${idx}`);
		params.push(updatedBy);
		idx++;
	}
	if (body.rules !== undefined) {
		sets.push(`rules = $${idx}`);
		params.push(body.rules);
		idx++;
	}

	if (sets.length === 0) {
		return ok(c, existing.rows[0]);
	}

	params.push(issueId);
	const result = await db.query(
		`UPDATE issues SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
		params,
	);

	wakeAgentIfAssigned(db, body.assignee_id, companyId, issueId);

	if (body.status === IssueStatus.Done) {
		const coach = await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE m.company_id = $1 AND ma.slug = 'coach'
			   AND ma.admin_status = $2::agent_admin_status
			 LIMIT 1`,
			[companyId, AgentAdminStatus.Enabled],
		);
		if (coach.rows.length > 0) {
			createWakeup(db, coach.rows[0].id, companyId, WakeupSource.Automation, {
				issue_id: issueId,
				trigger: 'issue_done',
			}).catch((e) => console.error('Failed to wake Coach:', e));
		}
	}

	broadcastChange(
		c,
		`company:${companyId}`,
		'issues',
		'UPDATE',
		result.rows[0] as Record<string, unknown>,
	);
	return ok(c, result.rows[0]);
});

issuesRoutes.delete('/companies/:companyId/issues/:issueId', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const issueId = c.req.param('issueId');

	const existing = await db.query<{ status: string }>(
		'SELECT status FROM issues WHERE id = $1 AND company_id = $2',
		[issueId, companyId],
	);
	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Issue not found', 404);
	}

	if (
		existing.rows[0].status !== IssueStatus.Backlog &&
		existing.rows[0].status !== IssueStatus.Open
	) {
		return err(c, 'FORBIDDEN', 'Can only delete issues with status backlog or open', 403);
	}

	const comments = await db.query<{ count: number }>(
		'SELECT count(*)::int AS count FROM issue_comments WHERE issue_id = $1',
		[issueId],
	);
	if (comments.rows[0].count > 0) {
		return err(c, 'CONFLICT', 'Cannot delete issue with comments', 409);
	}

	await db.query('DELETE FROM issues WHERE id = $1', [issueId]);
	broadcastChange(c, `company:${companyId}`, 'issues', 'DELETE', { id: issueId });
	return c.json({ data: null }, 200);
});

issuesRoutes.post('/companies/:companyId/issues/:issueId/sub-issues', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const parentIssueId = c.req.param('issueId');

	const parent = await db.query<{ project_id: string }>(
		'SELECT project_id FROM issues WHERE id = $1 AND company_id = $2',
		[parentIssueId, companyId],
	);
	if (parent.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Parent issue not found', 404);
	}

	const body = await c.req.json<{
		title: string;
		description?: string;
		assignee_id?: string;
		priority?: string;
		labels?: string[];
	}>();

	if (!body.title?.trim()) {
		return err(c, 'INVALID_REQUEST', 'title is required', 400);
	}
	if (!body.assignee_id) {
		return err(c, 'INVALID_REQUEST', 'assignee_id is required', 400);
	}

	const companyResult = await db.query<{ issue_prefix: string }>(
		'SELECT issue_prefix FROM companies WHERE id = $1',
		[companyId],
	);
	const numberResult = await db.query<{ number: number }>(
		'SELECT next_issue_number($1) AS number',
		[companyId],
	);
	const issueNumber = numberResult.rows[0].number;
	const identifier = `${companyResult.rows[0].issue_prefix}-${issueNumber}`;

	const result = await db.query(
		`INSERT INTO issues (company_id, project_id, assignee_id, parent_issue_id,
                         number, identifier, title, description, status, priority, labels)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::issue_status, $10::issue_priority, $11::jsonb)
     RETURNING *`,
		[
			companyId,
			parent.rows[0].project_id,
			body.assignee_id ?? null,
			parentIssueId,
			issueNumber,
			identifier,
			body.title.trim(),
			body.description ?? '',
			IssueStatus.Backlog,
			body.priority ?? IssuePriority.Medium,
			JSON.stringify(body.labels ?? []),
		],
	);

	const subIssue = result.rows[0] as Record<string, unknown>;
	broadcastChange(c, `company:${companyId}`, 'issues', 'INSERT', subIssue);
	wakeAgentIfAssigned(db, body.assignee_id, companyId, subIssue.id as string);
	return ok(c, subIssue, 201);
});

issuesRoutes.get('/companies/:companyId/issues/:issueId/dependencies', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const issueId = c.req.param('issueId');

	// Verify issue belongs to company
	const issueCheck = await db.query('SELECT id FROM issues WHERE id = $1 AND company_id = $2', [
		issueId,
		companyId,
	]);
	if (issueCheck.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Issue not found', 404);
	}

	const result = await db.query(
		`SELECT d.id, d.issue_id, d.blocked_by_issue_id, d.created_at,
            i.identifier AS blocked_by_identifier, i.title AS blocked_by_title, i.status AS blocked_by_status
     FROM issue_dependencies d
     JOIN issues i ON i.id = d.blocked_by_issue_id
     WHERE d.issue_id = $1`,
		[issueId],
	);
	return ok(c, result.rows);
});

issuesRoutes.post('/companies/:companyId/issues/:issueId/dependencies', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const issueId = c.req.param('issueId');
	const body = await c.req.json<{ blocked_by_issue_id: string }>();

	if (!body.blocked_by_issue_id) {
		return err(c, 'INVALID_REQUEST', 'blocked_by_issue_id is required', 400);
	}

	if (body.blocked_by_issue_id === issueId) {
		return err(c, 'INVALID_REQUEST', 'An issue cannot block itself', 400);
	}

	// Verify both issues belong to the same company
	const issueCheck = await db.query('SELECT id FROM issues WHERE id = $1 AND company_id = $2', [
		issueId,
		companyId,
	]);
	if (issueCheck.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Issue not found', 404);
	}

	const blockerCheck = await db.query('SELECT id FROM issues WHERE id = $1 AND company_id = $2', [
		body.blocked_by_issue_id,
		companyId,
	]);
	if (blockerCheck.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Blocking issue not found in this company', 404);
	}

	const result = await db.query(
		`INSERT INTO issue_dependencies (issue_id, blocked_by_issue_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING
     RETURNING *`,
		[issueId, body.blocked_by_issue_id],
	);

	if (result.rows.length === 0) {
		return err(c, 'CONFLICT', 'Dependency already exists', 409);
	}

	return ok(c, result.rows[0], 201);
});

issuesRoutes.delete('/companies/:companyId/issues/:issueId/dependencies/:depId', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const issueId = c.req.param('issueId');
	const depId = c.req.param('depId');

	// Verify issue belongs to company and dependency belongs to issue
	const depCheck = await db.query(
		`SELECT d.id FROM issue_dependencies d
     JOIN issues i ON i.id = d.issue_id
     WHERE d.id = $1 AND d.issue_id = $2 AND i.company_id = $3`,
		[depId, issueId, companyId],
	);
	if (depCheck.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Dependency not found', 404);
	}

	await db.query('DELETE FROM issue_dependencies WHERE id = $1', [depId]);
	return c.json({ data: null }, 200);
});
