import type { PGlite } from '@electric-sql/pglite';
import {
	AuditActorType,
	AuthType,
	TaskStatus,
	TERMINAL_TASK_STATUSES,
	WakeupSource,
	wsRoom,
} from '@hezo/shared';
import { type Context, Hono } from 'hono';
import { assertNoActiveRun } from '../lib/active-run';
import { isCoach } from '../lib/agent-roles';
import { broadcastChange } from '../lib/broadcast';
import {
	coerceTargetStatusForBlockers,
	reconcileBlockedStatus,
	wakeIfReady,
	wouldCreateCycle,
} from '../lib/dependencies';
import { assertOperationsAssignee } from '../lib/operations-assignee';
import { buildMeta, parsePagination } from '../lib/pagination';
import {
	getProjectLocator,
	resolveActorMemberId as resolveAuthActorMemberId,
	resolveProjectId,
	resolveTaskId,
} from '../lib/resolve';
import { err, ok } from '../lib/response';
import { assertChildrenAllClosed, assertNoOutstandingActivity } from '../lib/task-relationships';
import type { AuthInfo, Env } from '../lib/types';
import { logger } from '../logger';
import { requireTeamAccess } from '../middleware/auth';
import { removeTaskWorktrees } from '../services/repo-sync';
import { triggerStatusAutomations } from '../services/task-automation';
import { recordAssigneeChange, recordTaskLinks, recordTitleChange } from '../services/task-events';
import {
	type CreateTaskCaller,
	CreateTaskError,
	type CreateTaskInput,
	createTask,
} from '../services/tasks';
import { createWakeup } from '../services/wakeup';

const log = logger.child('routes');

const MAX_BATCH_TASKS = 50;

function actorTypeFromAuth(auth: AuthInfo): AuditActorType {
	return auth.type === AuthType.Agent ? AuditActorType.Agent : AuditActorType.Board;
}

async function buildCreateTaskCaller(c: Context<Env>, teamId: string): Promise<CreateTaskCaller> {
	const auth = c.get('auth');
	const actorMemberId = await resolveAuthActorMemberId(c.get('db'), auth, teamId);
	const caller: CreateTaskCaller = {
		actorType: actorTypeFromAuth(auth),
		actorMemberId,
	};
	if (auth.type === AuthType.Agent) {
		caller.agentMemberId = auth.memberId;
		caller.runId = auth.runId;
	}
	return caller;
}

async function wakeAgentIfAssigned(
	db: PGlite,
	assigneeId: string | null | undefined,
	teamId: string,
	taskId: string,
): Promise<void> {
	if (!assigneeId) return;
	const isAgent = await db.query('SELECT id FROM member_agents WHERE id = $1', [assigneeId]);
	if (isAgent.rows.length > 0) {
		createWakeup(db, assigneeId, teamId, WakeupSource.Assignment, {
			task_id: taskId,
		}).catch((e) => log.error('Failed to create wakeup for assignment:', e));
	}
}

async function resolveActorMemberId(c: Context<Env>, teamId: string): Promise<string | null> {
	return resolveAuthActorMemberId(c.get('db'), c.get('auth'), teamId);
}

export const tasksRoutes = new Hono<Env>();

tasksRoutes.get('/teams/:teamId/tasks', async (c) => {
	const access = await requireTeamAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { teamId } = access;
	const { page, perPage, offset } = parsePagination(c);

	const conditions: string[] = ['i.team_id = $1'];
	const params: unknown[] = [teamId];
	let idx = 2;

	const rawProjectId = c.req.query('project_id');
	if (rawProjectId) {
		const projectId = await resolveProjectId(db, teamId, rawProjectId);
		if (projectId) {
			conditions.push(`i.project_id = $${idx}`);
			params.push(projectId);
			idx++;
		}
	}

	const assigneeIdFilter = c.req.query('assignee_id');
	if (assigneeIdFilter) {
		const ids = assigneeIdFilter
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
		if (ids.length > 0) {
			const placeholders = ids.map((_, i) => `$${idx + i}`).join(', ');
			conditions.push(`i.assignee_id IN (${placeholders})`);
			params.push(...ids);
			idx += ids.length;
		}
	}

	const parentTaskId = c.req.query('parent_task_id');
	if (parentTaskId) {
		conditions.push(`i.parent_task_id = $${idx}`);
		params.push(parentTaskId);
		idx++;
	}

	const statusFilter = c.req.query('status');
	if (statusFilter) {
		const statuses = statusFilter.split(',').map((s) => s.trim());
		const placeholders = statuses.map((_, i) => `$${idx + i}::task_status`).join(', ');
		conditions.push(`i.status IN (${placeholders})`);
		params.push(...statuses);
		idx += statuses.length;
	}

	const priorityFilter = c.req.query('priority');
	if (priorityFilter) {
		const priorities = priorityFilter.split(',').map((s) => s.trim());
		const placeholders = priorities.map((_, i) => `$${idx + i}::task_priority`).join(', ');
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
		`SELECT count(*)::int AS count FROM tasks i WHERE ${where}`,
		params,
	);
	const total = countResult.rows[0].count;

	const dataParams = [...params, perPage, offset];
	const result = await db.query(
		`SELECT i.id, i.team_id, i.project_id, i.assignee_id, i.parent_task_id,
            i.number, i.identifier, i.title, i.description, i.status, i.priority,
            i.labels, i.created_at, i.updated_at,
            p.name AS project_name,
            COALESCE(ma.title, m.display_name) AS assignee_name,
            m.member_type AS assignee_type,
            EXISTS (
              SELECT 1 FROM heartbeat_runs hr
              WHERE hr.task_id = i.id AND hr.status IN ('running', 'queued')
            ) AS has_active_run
     FROM tasks i
     JOIN projects p ON p.id = i.project_id
     LEFT JOIN members m ON m.id = i.assignee_id
     LEFT JOIN member_agents ma ON ma.id = i.assignee_id
     WHERE ${where}
     ORDER BY EXISTS (
                SELECT 1 FROM heartbeat_runs hr
                WHERE hr.task_id = i.id AND hr.status IN ('running', 'queued')
              ) DESC,
              i.${sortColumn} ${sortDirection}
     LIMIT $${idx} OFFSET $${idx + 1}`,
		dataParams,
	);

	return c.json({ data: result.rows, meta: buildMeta(page, perPage, total) });
});

tasksRoutes.post('/teams/:teamId/tasks', async (c) => {
	const access = await requireTeamAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { teamId } = access;

	const body = await c.req.json<CreateTaskInput>();
	const caller = await buildCreateTaskCaller(c, teamId);

	try {
		const task = await createTask(db, teamId, body, caller, c.get('wsManager'));
		return ok(c, task, 201);
	} catch (e) {
		if (e instanceof CreateTaskError) {
			const status = e.code === 'NOT_FOUND' ? 404 : e.code === 'FORBIDDEN' ? 403 : 400;
			return err(c, e.code, e.message, status);
		}
		throw e;
	}
});

tasksRoutes.post('/teams/:teamId/tasks/batch', async (c) => {
	const access = await requireTeamAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { teamId } = access;

	const body = await c.req.json<{ items?: unknown }>();
	const raw = body.items;
	if (!Array.isArray(raw)) {
		return err(c, 'INVALID_REQUEST', 'items must be an array', 400);
	}
	if (raw.length === 0) {
		return err(c, 'INVALID_REQUEST', 'items must contain at least one entry', 400);
	}
	if (raw.length > MAX_BATCH_TASKS) {
		return err(c, 'INVALID_REQUEST', `items array may not exceed ${MAX_BATCH_TASKS} entries`, 400);
	}

	const caller = await buildCreateTaskCaller(c, teamId);
	const wsManager = c.get('wsManager');

	const results = await Promise.all(
		raw.map(async (item, index) => {
			try {
				const task = await createTask(db, teamId, item as CreateTaskInput, caller, wsManager);
				return { index, ok: true as const, task };
			} catch (e) {
				if (e instanceof CreateTaskError) {
					return { index, ok: false as const, error: e.message, code: e.code };
				}
				log.error('Unexpected error in batch task creation:', e);
				return {
					index,
					ok: false as const,
					error: e instanceof Error ? e.message : 'internal_error',
					code: 'INTERNAL_ERROR' as const,
				};
			}
		}),
	);

	return ok(c, results, 200);
});

tasksRoutes.get('/teams/:teamId/tasks/:taskId', async (c) => {
	const access = await requireTeamAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { teamId } = access;
	const taskId = await resolveTaskId(db, teamId, c.req.param('taskId'));
	if (!taskId) return err(c, 'NOT_FOUND', 'Task not found', 404);

	const result = await db.query(
		`SELECT i.*,
            p.name AS project_name, p.slug AS project_slug, p.description AS project_description,
            co.description AS team_description,
            COALESCE(ma.title, m.display_name) AS assignee_name,
            m.member_type AS assignee_type,
            COALESCE(ma_ps.title, m_ps.display_name) AS progress_summary_updated_by_name,
            (SELECT count(*)::int FROM task_comments ic WHERE ic.task_id = i.id) AS comment_count,
            (SELECT COALESCE(sum(ce.amount_cents), 0)::int FROM cost_entries ce WHERE ce.task_id = i.id) AS cost_cents,
            EXISTS (
              SELECT 1 FROM heartbeat_runs hr
              WHERE hr.task_id = i.id AND hr.status IN ('running', 'queued')
            ) AS has_active_run
     FROM tasks i
     JOIN projects p ON p.id = i.project_id
     JOIN teams co ON co.id = i.team_id
     LEFT JOIN members m ON m.id = i.assignee_id
     LEFT JOIN member_agents ma ON ma.id = i.assignee_id
     LEFT JOIN members m_ps ON m_ps.id = i.progress_summary_updated_by
     LEFT JOIN member_agents ma_ps ON ma_ps.id = i.progress_summary_updated_by
     WHERE i.id = $1 AND i.team_id = $2`,
		[taskId, teamId],
	);

	if (result.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Task not found', 404);
	}

	return ok(c, result.rows[0]);
});

tasksRoutes.post('/teams/:teamId/tasks/resolve', async (c) => {
	const access = await requireTeamAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { teamId } = access;

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
		 FROM tasks i JOIN projects p ON p.id = i.project_id
		 WHERE i.team_id = $1 AND LOWER(i.identifier) = ANY($2::text[])`,
		[teamId, identifiers],
	);
	return ok(c, result.rows);
});

tasksRoutes.get('/teams/:teamId/tasks/:taskId/latest-run', async (c) => {
	const access = await requireTeamAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { teamId } = access;
	const taskId = await resolveTaskId(db, teamId, c.req.param('taskId'));
	if (!taskId) return err(c, 'NOT_FOUND', 'Task not found', 404);

	const result = await db.query(
		`SELECT hr.id, hr.member_id, hr.status, hr.started_at, hr.finished_at,
		        hr.exit_code, hr.log_text, hr.invocation_command, hr.working_dir,
		        i.project_id AS project_id,
		        ma.title AS agent_title, ma.slug AS agent_slug
		 FROM heartbeat_runs hr
		 JOIN tasks i ON i.id = hr.task_id
		 LEFT JOIN member_agents ma ON ma.id = hr.member_id
		 WHERE hr.task_id = $1 AND hr.team_id = $2
		 ORDER BY hr.started_at DESC
		 LIMIT 1`,
		[taskId, teamId],
	);

	if (result.rows.length === 0) {
		return ok(c, null);
	}
	return ok(c, result.rows[0]);
});

tasksRoutes.patch('/teams/:teamId/tasks/:taskId', async (c) => {
	const access = await requireTeamAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { teamId } = access;
	const taskId = await resolveTaskId(db, teamId, c.req.param('taskId'));
	if (!taskId) return err(c, 'NOT_FOUND', 'Task not found', 404);

	const existing = await db.query<{
		id: string;
		title: string;
		status: string;
		project_id: string;
		assignee_id: string | null;
	}>(
		'SELECT id, title, status, project_id, assignee_id FROM tasks WHERE id = $1 AND team_id = $2',
		[taskId, teamId],
	);
	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Task not found', 404);
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

	const auth = c.get('auth');
	if (
		body.status !== undefined &&
		auth.type === AuthType.Agent &&
		existing.rows[0].status === TaskStatus.Closed
	) {
		return err(c, 'FORBIDDEN', 'Only board members can re-open a closed task', 403);
	}

	if (
		body.status === TaskStatus.Closed &&
		auth.type === AuthType.Agent &&
		!(await isCoach(db, auth))
	) {
		return err(
			c,
			'FORBIDDEN',
			'Only Coach can set status to "closed". Set status to "done" and Coach will close the task after review.',
			403,
		);
	}

	if (body.status === TaskStatus.Done || body.status === TaskStatus.Closed) {
		const childrenCheck = await assertChildrenAllClosed(db, teamId, taskId);
		if (!childrenCheck.ok) {
			return err(c, 'INVALID_REQUEST', childrenCheck.message, 400);
		}
	}
	if (body.status === TaskStatus.Done) {
		const callerMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
		const activityCheck = await assertNoOutstandingActivity(db, taskId, callerMemberId);
		if (!activityCheck.ok) {
			return err(c, 'INVALID_REQUEST', activityCheck.message, 400);
		}
	}

	if (body.status !== undefined) {
		body.status = await coerceTargetStatusForBlockers(db, taskId, body.status);
	}

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
		sets.push(`status = $${idx}::task_status`);
		params.push(body.status);
		idx++;
	}
	if (body.priority !== undefined) {
		sets.push(`priority = $${idx}::task_priority`);
		params.push(body.priority);
		idx++;
	}
	if (body.assignee_id !== undefined) {
		if (body.assignee_id === null) {
			return err(c, 'INVALID_REQUEST', 'assignee_id cannot be null', 400);
		}
		if (body.assignee_id !== existing.rows[0].assignee_id) {
			const activeRunCheck = await assertNoActiveRun(db, taskId);
			if (!activeRunCheck.ok) {
				return err(c, 'CONFLICT', activeRunCheck.message, 409);
			}
		}
		const opsCheck = await assertOperationsAssignee(
			db,
			teamId,
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

	params.push(taskId);
	const result = await db.query(
		`UPDATE tasks SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
		params,
	);

	if (body.assignee_id && body.assignee_id !== existing.rows[0].assignee_id) {
		wakeAgentIfAssigned(db, body.assignee_id, teamId, taskId);
	}

	const actorMemberId = await resolveActorMemberId(c, teamId);

	if (body.description !== undefined) {
		recordTaskLinks(db, teamId, taskId, body.description, actorMemberId, c.get('wsManager')).catch(
			(e) => log.error('Failed to record task links from description:', e),
		);
	}

	if (body.title !== undefined) {
		recordTitleChange(
			db,
			teamId,
			taskId,
			existing.rows[0].title,
			body.title.trim(),
			actorMemberId,
			c.get('wsManager'),
		).catch((e) => log.error('Failed to record title change:', e));
	}

	if (body.assignee_id !== undefined && body.assignee_id !== existing.rows[0].assignee_id) {
		recordAssigneeChange(
			db,
			teamId,
			taskId,
			existing.rows[0].assignee_id,
			body.assignee_id,
			actorMemberId,
			c.get('wsManager'),
		).catch((e) => log.error('Failed to record assignee change:', e));
	}

	if (body.status) {
		triggerStatusAutomations(
			db,
			teamId,
			taskId,
			existing.rows[0].status,
			body.status,
			actorMemberId,
			c.get('wsManager'),
		).catch((e) => log.error('Failed to trigger status automations:', e));

		if ((TERMINAL_TASK_STATUSES as readonly string[]).includes(body.status)) {
			const dataDir = c.get('dataDir');
			if (dataDir) {
				const taskRow = await db.query<{ identifier: string; project_id: string }>(
					'SELECT identifier, project_id FROM tasks WHERE id = $1',
					[taskId],
				);
				const taskInfo = taskRow.rows[0];
				if (taskInfo) {
					const locator = await getProjectLocator(db, taskInfo.project_id);
					if (locator) {
						try {
							removeTaskWorktrees(dataDir, locator.teamSlug, locator.slug, taskInfo.identifier);
						} catch (error) {
							log.error(`Failed to clean up worktrees for task ${taskInfo.identifier}:`, error);
						}
					}
				}
			}
		}
	}

	broadcastChange(
		c,
		wsRoom.team(teamId),
		'tasks',
		'UPDATE',
		result.rows[0] as Record<string, unknown>,
	);
	return ok(c, result.rows[0]);
});

tasksRoutes.post('/teams/:teamId/tasks/:taskId/sub-tasks', async (c) => {
	const access = await requireTeamAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { teamId } = access;
	const parentTaskId = await resolveTaskId(db, teamId, c.req.param('taskId'));
	if (!parentTaskId) return err(c, 'NOT_FOUND', 'Parent task not found', 404);

	const parent = await db.query<{ project_id: string }>(
		'SELECT project_id FROM tasks WHERE id = $1 AND team_id = $2',
		[parentTaskId, teamId],
	);
	if (parent.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Parent task not found', 404);
	}

	const body = await c.req.json<Omit<CreateTaskInput, 'project_id' | 'parent_task_id'>>();
	const caller = await buildCreateTaskCaller(c, teamId);

	try {
		const subTask = await createTask(
			db,
			teamId,
			{
				...body,
				project_id: parent.rows[0].project_id,
				parent_task_id: parentTaskId,
			},
			caller,
			c.get('wsManager'),
		);
		return ok(c, subTask, 201);
	} catch (e) {
		if (e instanceof CreateTaskError) {
			const status = e.code === 'NOT_FOUND' ? 404 : e.code === 'FORBIDDEN' ? 403 : 400;
			return err(c, e.code, e.message, status);
		}
		throw e;
	}
});

tasksRoutes.get('/teams/:teamId/tasks/:taskId/ancestors', async (c) => {
	const access = await requireTeamAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { teamId } = access;
	const taskId = await resolveTaskId(db, teamId, c.req.param('taskId'));
	if (!taskId) return err(c, 'NOT_FOUND', 'Task not found', 404);

	const result = await db.query<{
		id: string;
		identifier: string;
		title: string;
		depth: number;
	}>(
		`WITH RECURSIVE chain AS (
			SELECT id, parent_task_id, identifier, title, 0 AS depth
			FROM tasks WHERE id = $1 AND team_id = $2
			UNION ALL
			SELECT i.id, i.parent_task_id, i.identifier, i.title, c.depth + 1
			FROM tasks i
			JOIN chain c ON c.parent_task_id = i.id
			WHERE i.team_id = $2 AND c.depth < 3
		)
		SELECT id, identifier, title, depth FROM chain ORDER BY depth DESC`,
		[taskId, teamId],
	);
	if (result.rows.length === 0) return err(c, 'NOT_FOUND', 'Task not found', 404);
	return ok(
		c,
		result.rows
			.filter((r) => r.depth > 0)
			.map(({ id, identifier, title }) => ({ id, identifier, title })),
	);
});

tasksRoutes.get('/teams/:teamId/tasks/:taskId/dependencies', async (c) => {
	const access = await requireTeamAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { teamId } = access;
	const taskId = await resolveTaskId(db, teamId, c.req.param('taskId'));
	if (!taskId) return err(c, 'NOT_FOUND', 'Task not found', 404);

	const result = await db.query(
		`SELECT d.id, d.task_id, d.blocked_by_task_id, d.created_at,
            i.identifier AS blocked_by_identifier, i.title AS blocked_by_title, i.status AS blocked_by_status,
            p.slug AS blocked_by_project_slug
     FROM task_dependencies d
     JOIN tasks i ON i.id = d.blocked_by_task_id
     JOIN projects p ON p.id = i.project_id
     WHERE d.task_id = $1`,
		[taskId],
	);
	return ok(c, result.rows);
});

tasksRoutes.post('/teams/:teamId/tasks/:taskId/dependencies', async (c) => {
	const access = await requireTeamAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { teamId } = access;
	const taskId = await resolveTaskId(db, teamId, c.req.param('taskId'));
	if (!taskId) return err(c, 'NOT_FOUND', 'Task not found', 404);
	const body = await c.req.json<{ blocked_by_task_id: string }>();

	if (!body.blocked_by_task_id) {
		return err(c, 'INVALID_REQUEST', 'blocked_by_task_id is required', 400);
	}

	const blockerId = await resolveTaskId(db, teamId, body.blocked_by_task_id);
	if (!blockerId) {
		return err(c, 'NOT_FOUND', 'Blocking task not found in this team', 404);
	}

	if (blockerId === taskId) {
		return err(c, 'INVALID_REQUEST', 'An task cannot block itself', 400);
	}

	if (await wouldCreateCycle(db, taskId, blockerId)) {
		return err(c, 'INVALID_REQUEST', 'Dependency would create a cycle', 400);
	}

	const result = await db.query(
		`INSERT INTO task_dependencies (task_id, blocked_by_task_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING
     RETURNING *`,
		[taskId, blockerId],
	);

	if (result.rows.length === 0) {
		return err(c, 'CONFLICT', 'Dependency already exists', 409);
	}

	const actorMemberId = await resolveActorMemberId(c, teamId);
	await reconcileBlockedStatus(db, teamId, taskId, actorMemberId, c.get('wsManager'));

	return ok(c, result.rows[0], 201);
});

tasksRoutes.delete('/teams/:teamId/tasks/:taskId/dependencies/:depId', async (c) => {
	const access = await requireTeamAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { teamId } = access;
	const taskId = await resolveTaskId(db, teamId, c.req.param('taskId'));
	if (!taskId) return err(c, 'NOT_FOUND', 'Task not found', 404);
	const depId = c.req.param('depId');

	const depCheck = await db.query(
		`SELECT d.id FROM task_dependencies d
     JOIN tasks i ON i.id = d.task_id
     WHERE d.id = $1 AND d.task_id = $2 AND i.team_id = $3`,
		[depId, taskId, teamId],
	);
	if (depCheck.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Dependency not found', 404);
	}

	await db.query('DELETE FROM task_dependencies WHERE id = $1', [depId]);
	const actorMemberId = await resolveActorMemberId(c, teamId);
	await reconcileBlockedStatus(db, teamId, taskId, actorMemberId, c.get('wsManager'));
	await wakeIfReady(db, taskId);
	return c.json({ data: null }, 200);
});
