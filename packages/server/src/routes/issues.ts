import { Hono } from 'hono';
import { buildMeta, parsePagination } from '../lib/pagination';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { createWakeup } from '../services/wakeup';

export const issuesRoutes = new Hono<Env>();

issuesRoutes.get('/companies/:companyId/issues', async (c) => {
	const db = c.get('db');
	const companyId = c.req.param('companyId');
	const { page, perPage, offset } = parsePagination(c);

	const conditions: string[] = ['i.company_id = $1'];
	const params: unknown[] = [companyId];
	let idx = 2;

	const projectId = c.req.query('project_id');
	if (projectId) {
		conditions.push(`i.project_id = $${idx}`);
		params.push(projectId);
		idx++;
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

	// Sort
	const sortParam = c.req.query('sort') || 'created_at:desc';
	const [sortField, sortDir] = sortParam.split(':');
	const allowedSorts = ['created_at', 'updated_at', 'priority', 'number'];
	const sortColumn = allowedSorts.includes(sortField) ? sortField : 'created_at';
	const sortDirection = sortDir === 'asc' ? 'ASC' : 'DESC';

	// Count
	const countResult = await db.query<{ count: number }>(
		`SELECT count(*)::int AS count FROM issues i WHERE ${where}`,
		params,
	);
	const total = countResult.rows[0].count;

	// Fetch
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
	const db = c.get('db');
	const companyId = c.req.param('companyId');

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

	// Get issue prefix
	const companyResult = await db.query<{ issue_prefix: string }>(
		'SELECT issue_prefix FROM companies WHERE id = $1',
		[companyId],
	);
	if (companyResult.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Company not found', 404);
	}

	// Get next number atomically
	const numberResult = await db.query<{ number: number }>(
		'SELECT next_issue_number($1) AS number',
		[companyId],
	);
	const issueNumber = numberResult.rows[0].number;
	const identifier = `${companyResult.rows[0].issue_prefix}-${issueNumber}`;

	const result = await db.query(
		`INSERT INTO issues (company_id, project_id, assignee_id, parent_issue_id,
                         number, identifier, title, description, status, priority, labels)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'backlog', $9::issue_priority, $10::jsonb)
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
			body.priority ?? 'medium',
			JSON.stringify(body.labels ?? []),
		],
	);

	return ok(c, result.rows[0], 201);
});

issuesRoutes.get('/companies/:companyId/issues/:issueId', async (c) => {
	const db = c.get('db');
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
		[c.req.param('issueId'), c.req.param('companyId')],
	);

	if (result.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Issue not found', 404);
	}

	return ok(c, result.rows[0]);
});

issuesRoutes.patch('/companies/:companyId/issues/:issueId', async (c) => {
	const db = c.get('db');
	const issueId = c.req.param('issueId');
	const companyId = c.req.param('companyId');

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
		const updatedBy = auth.type === 'agent' ? auth.memberId : null;
		sets.push(`progress_summary_updated_by = $${idx}`);
		params.push(updatedBy);
		idx++;
	}

	if (sets.length === 0) {
		return ok(c, (existing as any).rows[0]);
	}

	params.push(issueId);
	const result = await db.query(
		`UPDATE issues SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
		params,
	);

	if (body.assignee_id) {
		const isAgent = await db.query('SELECT id FROM member_agents WHERE id = $1', [
			body.assignee_id,
		]);
		if (isAgent.rows.length > 0) {
			createWakeup(db, body.assignee_id, companyId, 'assignment', {
				issue_id: issueId,
			}).catch((e) => console.error('Failed to create wakeup:', e));
		}
	}

	return ok(c, result.rows[0]);
});

issuesRoutes.delete('/companies/:companyId/issues/:issueId', async (c) => {
	const db = c.get('db');
	const issueId = c.req.param('issueId');
	const companyId = c.req.param('companyId');

	const existing = await db.query<{ status: string }>(
		'SELECT status FROM issues WHERE id = $1 AND company_id = $2',
		[issueId, companyId],
	);
	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Issue not found', 404);
	}

	if (!['backlog', 'open'].includes(existing.rows[0].status)) {
		return err(c, 'FORBIDDEN', 'Can only delete issues with status backlog or open', 403);
	}

	// Check for comments
	const comments = await db.query<{ count: number }>(
		'SELECT count(*)::int AS count FROM issue_comments WHERE issue_id = $1',
		[issueId],
	);
	if (comments.rows[0].count > 0) {
		return err(c, 'CONFLICT', 'Cannot delete issue with comments', 409);
	}

	await db.query('DELETE FROM issues WHERE id = $1', [issueId]);
	return c.json({ data: null }, 200);
});

// Sub-issues
issuesRoutes.post('/companies/:companyId/issues/:issueId/sub-issues', async (c) => {
	const db = c.get('db');
	const companyId = c.req.param('companyId');
	const parentIssueId = c.req.param('issueId');

	// Verify parent exists
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
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'backlog', $9::issue_priority, $10::jsonb)
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
			body.priority ?? 'medium',
			JSON.stringify(body.labels ?? []),
		],
	);

	return ok(c, result.rows[0], 201);
});

// Dependencies
issuesRoutes.get('/companies/:companyId/issues/:issueId/dependencies', async (c) => {
	const db = c.get('db');
	const result = await db.query(
		`SELECT d.id, d.issue_id, d.blocked_by_issue_id, d.created_at,
            i.identifier AS blocked_by_identifier, i.title AS blocked_by_title, i.status AS blocked_by_status
     FROM issue_dependencies d
     JOIN issues i ON i.id = d.blocked_by_issue_id
     WHERE d.issue_id = $1`,
		[c.req.param('issueId')],
	);
	return ok(c, result.rows);
});

issuesRoutes.post('/companies/:companyId/issues/:issueId/dependencies', async (c) => {
	const db = c.get('db');
	const issueId = c.req.param('issueId');
	const body = await c.req.json<{ blocked_by_issue_id: string }>();

	if (!body.blocked_by_issue_id) {
		return err(c, 'INVALID_REQUEST', 'blocked_by_issue_id is required', 400);
	}

	if (body.blocked_by_issue_id === issueId) {
		return err(c, 'INVALID_REQUEST', 'An issue cannot block itself', 400);
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
	const db = c.get('db');
	await db.query('DELETE FROM issue_dependencies WHERE id = $1', [c.req.param('depId')]);
	return c.json({ data: null }, 200);
});
