import type { PGlite } from '@electric-sql/pglite';
import {
	AuditAction,
	AuditActorType,
	AuditEntityType,
	AuthType,
	IssuePriority,
	IssueStatus,
	TERMINAL_ISSUE_STATUSES,
	WakeupSource,
	wsRoom,
} from '@hezo/shared';
import { Hono } from 'hono';
import { assertNoActiveRun } from '../lib/active-run';
import { auditLog } from '../lib/audit';
import { broadcastChange } from '../lib/broadcast';
import { allocateIssueIdentifier } from '../lib/issue-identifier';
import { assertOperationsAssignee } from '../lib/operations-assignee';
import { buildMeta, parsePagination } from '../lib/pagination';
import { getProjectLocator, resolveIssueId, resolveProjectId } from '../lib/resolve';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { logger } from '../logger';
import { requireCompanyAccess } from '../middleware/auth';
import { triggerStatusAutomations } from '../services/issue-automation';
import { removeIssueWorktrees } from '../services/repo-sync';
import { createWakeup } from '../services/wakeup';

const log = logger.child('routes');

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
		}).catch((e) => log.error('Failed to create wakeup for assignment:', e));
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

	const parentIssueId = c.req.query('parent_issue_id');
	if (parentIssueId) {
		conditions.push(`i.parent_issue_id = $${idx}`);
		params.push(parentIssueId);
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
            COALESCE(ma.title, m.display_name) AS assignee_name,
            m.member_type AS assignee_type,
            EXISTS (
              SELECT 1 FROM heartbeat_runs hr
              WHERE hr.issue_id = i.id AND hr.status IN ('running', 'queued')
            ) AS has_active_run
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
		runtime_type?: string;
	}>();

	if (!body.project_id || !body.title?.trim()) {
		return err(c, 'INVALID_REQUEST', 'project_id and title are required', 400);
	}
	if (!body.assignee_id) {
		return err(c, 'INVALID_REQUEST', 'assignee_id is required', 400);
	}

	const opsCheck = await assertOperationsAssignee(db, companyId, body.project_id, body.assignee_id);
	if (!opsCheck.ok) {
		return err(c, 'INVALID_REQUEST', opsCheck.message, 400);
	}

	const { number: issueNumber, identifier } = await allocateIssueIdentifier(db, body.project_id);

	const result = await db.query(
		`INSERT INTO issues (company_id, project_id, assignee_id, parent_issue_id,
                         number, identifier, title, description, status, priority, labels, runtime_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::issue_status, $10::issue_priority, $11::jsonb, $12::agent_runtime)
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
			body.runtime_type ?? null,
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
			}).catch((e) => log.error('Failed to create wakeup:', e));
		}
	}

	broadcastChange(c, wsRoom.company(companyId), 'issues', 'INSERT', issue);
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
	const issueId = await resolveIssueId(db, companyId, c.req.param('issueId'));
	if (!issueId) return err(c, 'NOT_FOUND', 'Issue not found', 404);

	const result = await db.query(
		`SELECT i.*,
            p.name AS project_name, p.slug AS project_slug, p.description AS project_description,
            co.description AS company_description,
            COALESCE(ma.title, m.display_name) AS assignee_name,
            m.member_type AS assignee_type,
            COALESCE(ma_ps.title, m_ps.display_name) AS progress_summary_updated_by_name,
            (SELECT count(*)::int FROM issue_comments ic WHERE ic.issue_id = i.id) AS comment_count,
            (SELECT COALESCE(sum(ce.amount_cents), 0)::int FROM cost_entries ce WHERE ce.issue_id = i.id) AS cost_cents,
            EXISTS (
              SELECT 1 FROM heartbeat_runs hr
              WHERE hr.issue_id = i.id AND hr.status IN ('running', 'queued')
            ) AS has_active_run
     FROM issues i
     JOIN projects p ON p.id = i.project_id
     JOIN companies co ON co.id = i.company_id
     LEFT JOIN members m ON m.id = i.assignee_id
     LEFT JOIN member_agents ma ON ma.id = i.assignee_id
     LEFT JOIN members m_ps ON m_ps.id = i.progress_summary_updated_by
     LEFT JOIN member_agents ma_ps ON ma_ps.id = i.progress_summary_updated_by
     WHERE i.id = $1 AND i.company_id = $2`,
		[issueId, companyId],
	);

	if (result.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Issue not found', 404);
	}

	return ok(c, result.rows[0]);
});

issuesRoutes.post('/companies/:companyId/issues/resolve', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;

	const body = await c.req.json<{ identifiers?: unknown }>();
	const raw = body.identifiers;
	if (!Array.isArray(raw)) {
		return err(c, 'INVALID_REQUEST', 'identifiers must be an array of strings', 400);
	}
	if (raw.length > 100) {
		return err(c, 'INVALID_REQUEST', 'identifiers array may not exceed 100 entries', 400);
	}
	const identifiers = Array.from(
		new Set(
			raw
				.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
				.map((v) => v.trim().toLowerCase()),
		),
	);
	if (identifiers.length === 0) return ok(c, []);

	const result = await db.query<{
		identifier: string;
		title: string;
		project_slug: string;
		status: string;
	}>(
		`SELECT i.identifier, i.title, p.slug AS project_slug, i.status::text AS status
		 FROM issues i JOIN projects p ON p.id = i.project_id
		 WHERE i.company_id = $1 AND LOWER(i.identifier) = ANY($2::text[])`,
		[companyId, identifiers],
	);
	return ok(c, result.rows);
});

issuesRoutes.get('/companies/:companyId/issues/:issueId/latest-run', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const issueId = await resolveIssueId(db, companyId, c.req.param('issueId'));
	if (!issueId) return err(c, 'NOT_FOUND', 'Issue not found', 404);

	const result = await db.query(
		`SELECT hr.id, hr.member_id, hr.status, hr.started_at, hr.finished_at,
		        hr.exit_code, hr.log_text, hr.invocation_command, hr.working_dir,
		        i.project_id AS project_id,
		        ma.title AS agent_title, ma.slug AS agent_slug
		 FROM heartbeat_runs hr
		 JOIN issues i ON i.id = hr.issue_id
		 LEFT JOIN member_agents ma ON ma.id = hr.member_id
		 WHERE hr.issue_id = $1 AND hr.company_id = $2
		 ORDER BY hr.started_at DESC
		 LIMIT 1`,
		[issueId, companyId],
	);

	if (result.rows.length === 0) {
		return ok(c, null);
	}
	return ok(c, result.rows[0]);
});

issuesRoutes.patch('/companies/:companyId/issues/:issueId', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const issueId = await resolveIssueId(db, companyId, c.req.param('issueId'));
	if (!issueId) return err(c, 'NOT_FOUND', 'Issue not found', 404);

	const existing = await db.query<{
		id: string;
		status: string;
		project_id: string;
		assignee_id: string | null;
	}>('SELECT id, status, project_id, assignee_id FROM issues WHERE id = $1 AND company_id = $2', [
		issueId,
		companyId,
	]);
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
		branch_name?: string | null;
		runtime_type?: string | null;
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
		if (body.assignee_id !== existing.rows[0].assignee_id) {
			const activeRunCheck = await assertNoActiveRun(db, issueId);
			if (!activeRunCheck.ok) {
				return err(c, 'CONFLICT', activeRunCheck.message, 409);
			}
		}
		const opsCheck = await assertOperationsAssignee(
			db,
			companyId,
			existing.rows[0].project_id,
			body.assignee_id,
		);
		if (!opsCheck.ok) {
			return err(c, 'INVALID_REQUEST', opsCheck.message, 400);
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
	if (body.branch_name !== undefined) {
		sets.push(`branch_name = $${idx}`);
		params.push(body.branch_name);
		idx++;
	}
	if (body.runtime_type !== undefined) {
		sets.push(`runtime_type = $${idx}::agent_runtime`);
		params.push(body.runtime_type);
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

	if (body.status) {
		triggerStatusAutomations(db, companyId, issueId, body.status, c.get('wsManager')).catch((e) =>
			log.error('Failed to trigger status automations:', e),
		);

		if ((TERMINAL_ISSUE_STATUSES as readonly string[]).includes(body.status)) {
			const dataDir = c.get('dataDir');
			if (dataDir) {
				const issueRow = await db.query<{ identifier: string; project_id: string }>(
					'SELECT identifier, project_id FROM issues WHERE id = $1',
					[issueId],
				);
				const issueInfo = issueRow.rows[0];
				if (issueInfo) {
					const locator = await getProjectLocator(db, issueInfo.project_id);
					if (locator) {
						try {
							removeIssueWorktrees(
								dataDir,
								locator.companySlug,
								locator.slug,
								issueInfo.identifier,
							);
						} catch (error) {
							log.error(`Failed to clean up worktrees for issue ${issueInfo.identifier}:`, error);
						}
					}
				}
			}
		}
	}

	broadcastChange(
		c,
		wsRoom.company(companyId),
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
	const issueId = await resolveIssueId(db, companyId, c.req.param('issueId'));
	if (!issueId) return err(c, 'NOT_FOUND', 'Issue not found', 404);

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
	broadcastChange(c, wsRoom.company(companyId), 'issues', 'DELETE', { id: issueId });
	return c.json({ data: null }, 200);
});

issuesRoutes.post('/companies/:companyId/issues/:issueId/sub-issues', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const parentIssueId = await resolveIssueId(db, companyId, c.req.param('issueId'));
	if (!parentIssueId) return err(c, 'NOT_FOUND', 'Parent issue not found', 404);

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
		runtime_type?: string;
	}>();

	if (!body.title?.trim()) {
		return err(c, 'INVALID_REQUEST', 'title is required', 400);
	}
	if (!body.assignee_id) {
		return err(c, 'INVALID_REQUEST', 'assignee_id is required', 400);
	}

	const opsCheck = await assertOperationsAssignee(
		db,
		companyId,
		parent.rows[0].project_id,
		body.assignee_id,
	);
	if (!opsCheck.ok) {
		return err(c, 'INVALID_REQUEST', opsCheck.message, 400);
	}

	const { number: issueNumber, identifier } = await allocateIssueIdentifier(
		db,
		parent.rows[0].project_id,
	);

	const result = await db.query(
		`INSERT INTO issues (company_id, project_id, assignee_id, parent_issue_id,
                         number, identifier, title, description, status, priority, labels, runtime_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::issue_status, $10::issue_priority, $11::jsonb, $12::agent_runtime)
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
			body.runtime_type ?? null,
		],
	);

	const subIssue = result.rows[0] as Record<string, unknown>;
	broadcastChange(c, wsRoom.company(companyId), 'issues', 'INSERT', subIssue);
	wakeAgentIfAssigned(db, body.assignee_id, companyId, subIssue.id as string);
	return ok(c, subIssue, 201);
});

issuesRoutes.get('/companies/:companyId/issues/:issueId/dependencies', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const issueId = await resolveIssueId(db, companyId, c.req.param('issueId'));
	if (!issueId) return err(c, 'NOT_FOUND', 'Issue not found', 404);

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
	const issueId = await resolveIssueId(db, companyId, c.req.param('issueId'));
	if (!issueId) return err(c, 'NOT_FOUND', 'Issue not found', 404);
	const body = await c.req.json<{ blocked_by_issue_id: string }>();

	if (!body.blocked_by_issue_id) {
		return err(c, 'INVALID_REQUEST', 'blocked_by_issue_id is required', 400);
	}

	const blockerId = await resolveIssueId(db, companyId, body.blocked_by_issue_id);
	if (!blockerId) {
		return err(c, 'NOT_FOUND', 'Blocking issue not found in this company', 404);
	}

	if (blockerId === issueId) {
		return err(c, 'INVALID_REQUEST', 'An issue cannot block itself', 400);
	}

	const result = await db.query(
		`INSERT INTO issue_dependencies (issue_id, blocked_by_issue_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING
     RETURNING *`,
		[issueId, blockerId],
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
	const issueId = await resolveIssueId(db, companyId, c.req.param('issueId'));
	if (!issueId) return err(c, 'NOT_FOUND', 'Issue not found', 404);
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
