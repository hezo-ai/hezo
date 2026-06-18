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
import { trackBackground } from '../lib/background';
import { broadcastChange } from '../lib/broadcast';
import {
	coerceTargetStatusForBlockers,
	reconcileBlockedStatus,
	wakeIfReady,
	wouldCreateCycle,
} from '../lib/dependencies';
import { buildMeta, parsePagination } from '../lib/pagination';
import {
	actorTypeFromAuth,
	getProjectLocator,
	resolveActorMemberId as resolveAuthActorMemberId,
	resolveTaskId,
} from '../lib/resolve';
import { err, ok } from '../lib/response';
import { assertRunTaskScope } from '../lib/run-scope';
import { assertChildrenAllClosed, assertNoOutstandingActivity } from '../lib/task-relationships';
import { buildTaskListOrderBy, parseTaskListSort } from '../lib/task-sort';
import type { AuthInfo, Env } from '../lib/types';
import { logger } from '../logger';
import { removeTaskWorktrees } from '../services/repo-sync';
import { terminateRunsForTask } from '../services/run-termination';
import { triggerStatusAutomations } from '../services/task-automation';
import { recordAssigneeChange, recordTaskLinks, recordTitleChange } from '../services/task-events';
import { getTaskProgressSummary } from '../services/task-progress-summary';
import {
	type CreateTaskCaller,
	CreateTaskError,
	type CreateTaskInput,
	createTask,
	createTaskBatch,
} from '../services/tasks';
import { createWakeup } from '../services/wakeup';

const log = logger.child('routes');

const MAX_BATCH_TASKS = 50;

async function buildCreateTaskCaller(c: Context<Env>, teamId: string): Promise<CreateTaskCaller> {
	const auth = c.get('auth');
	const actorMemberId = await resolveAuthActorMemberId(c.get('db'), auth, teamId);
	const caller: CreateTaskCaller = {
		actorType: actorTypeFromAuth(auth),
		actorMemberId,
	};
	if (auth.type === AuthType.Agent) {
		caller.agentMemberId = auth.memberId;
		caller.runId = auth.runId ?? undefined;
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
		trackBackground(
			createWakeup(db, assigneeId, teamId, WakeupSource.Assignment, {
				task_id: taskId,
			}).catch((e) => log.error('Failed to create wakeup for assignment:', e)),
		);
	}
}

async function resolveActorMemberId(c: Context<Env>, teamId: string): Promise<string | null> {
	return resolveAuthActorMemberId(c.get('db'), c.get('auth'), teamId);
}

export const tasksRoutes = new Hono<Env>();

tasksRoutes.get('/projects/:projectId/tasks', async (c) => {
	const projectId = c.get('projectId') as string;
	const db = c.get('db');
	const { page, perPage, offset } = parsePagination(c);

	// Only admin users have an inbox, so the per-task unread-mention notice is
	// scoped to the authenticated admin user; other callers (agents, API keys)
	// get `false` because `bm.user_id = NULL` never matches.
	const auth = c.get('auth');
	const adminUserId = auth.type === AuthType.Admin ? auth.userId : null;

	// The list is scoped to the project named in the URL — the project is the
	// public handle, so tasks are addressed per project rather than per team.
	const conditions: string[] = ['i.project_id = $1'];
	const params: unknown[] = [projectId];
	let idx = 2;

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

	const { field: sortField, direction: sortDirection } = parseTaskListSort(c.req.query('sort'));

	const countResult = await db.query<{ count: number }>(
		`SELECT count(*)::int AS count FROM tasks i WHERE ${where}`,
		params,
	);
	const total = countResult.rows[0].count;

	const orderBy = buildTaskListOrderBy(sortField, sortDirection, params, idx);
	idx = orderBy.nextIdx;

	const dataParams = [...params, adminUserId, perPage, offset];
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
            ) AS has_active_run,
            EXISTS (
              SELECT 1 FROM admin_mentions bm
              WHERE bm.task_id = i.id AND bm.user_id = $${idx}
                AND bm.read_at IS NULL AND bm.archived_at IS NULL
            ) AS has_unread_admin_mention,
            lr.status AS last_run_status,
            CASE WHEN qw.last_skipped_reason IS NOT NULL THEN json_build_object(
              'reason', qw.last_skipped_reason,
              'since', qw.last_skipped_at,
              'blocker_task_id', qw.last_skipped_blocker_task_id,
              'blocker_identifier', qw.blocker_identifier,
              'blocker_project_slug', qw.blocker_project_slug
            ) ELSE NULL END AS queued_wakeup
     FROM tasks i
     JOIN projects p ON p.id = i.project_id
     LEFT JOIN members m ON m.id = i.assignee_id
     LEFT JOIN member_agents ma ON ma.id = i.assignee_id
     LEFT JOIN LATERAL (
       SELECT w.last_skipped_reason, w.last_skipped_at, w.last_skipped_blocker_task_id,
              b.identifier AS blocker_identifier,
              bp.slug AS blocker_project_slug
       FROM agent_wakeup_requests w
       LEFT JOIN tasks b ON b.id = w.last_skipped_blocker_task_id
       LEFT JOIN projects bp ON bp.id = b.project_id
       WHERE w.member_id = i.assignee_id
         AND w.payload->>'task_id' = i.id::text
         AND w.status = 'queued'
         AND w.last_skipped_at IS NOT NULL
       ORDER BY w.last_skipped_at DESC
       LIMIT 1
     ) qw ON true
     LEFT JOIN LATERAL (
       SELECT hr.status
       FROM heartbeat_runs hr
       WHERE hr.task_id = i.id
         AND hr.status NOT IN ('queued', 'running')
       ORDER BY hr.finished_at DESC NULLS LAST, hr.started_at DESC
       LIMIT 1
     ) lr ON true
     WHERE ${where}
     ORDER BY ${orderBy.sql}
     LIMIT $${idx + 1} OFFSET $${idx + 2}`,
		dataParams,
	);

	return c.json({ data: result.rows, meta: buildMeta(page, perPage, total) });
});

tasksRoutes.get('/projects/:projectId/tasks/progress-summary', async (c) => {
	const projectId = c.get('projectId') as string;
	const summary = await getTaskProgressSummary(c.get('db'), projectId);
	return c.json({ data: summary });
});

tasksRoutes.post('/projects/:projectId/tasks', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');

	const body = await c.req.json<CreateTaskInput>();
	// Tasks are created within the project named in the URL unless the caller
	// targets a different project explicitly.
	if (!body.project_id) body.project_id = c.get('projectId') as string;
	const caller = await buildCreateTaskCaller(c, teamId);

	try {
		const task = await createTask(db, teamId, body, caller, c.get('wsManager'), c.get('events'));
		return ok(c, task, 201);
	} catch (e) {
		if (e instanceof CreateTaskError) {
			const status = e.code === 'NOT_FOUND' ? 404 : e.code === 'FORBIDDEN' ? 403 : 400;
			return err(c, e.code, e.message, status);
		}
		throw e;
	}
});

tasksRoutes.post('/projects/:projectId/tasks/batch', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');

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

	const results = await createTaskBatch(
		db,
		teamId,
		raw as CreateTaskInput[],
		caller,
		c.get('wsManager'),
		c.get('events'),
	);

	return ok(c, results, 200);
});

tasksRoutes.get('/projects/:projectId/tasks/:taskId', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
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
            EXISTS (
              SELECT 1 FROM heartbeat_runs hr
              WHERE hr.task_id = i.id AND hr.status IN ('running', 'queued')
            ) AS has_active_run,
            lr.status AS last_run_status,
            lr.run_id AS last_run_id,
            lr.comment_id AS last_run_comment_id,
            lr.comment_public_id AS last_run_comment_public_id,
            CASE WHEN qw.last_skipped_reason IS NOT NULL THEN json_build_object(
              'reason', qw.last_skipped_reason,
              'since', qw.last_skipped_at,
              'blocker_task_id', qw.last_skipped_blocker_task_id,
              'blocker_identifier', qw.blocker_identifier,
              'blocker_project_slug', qw.blocker_project_slug
            ) ELSE NULL END AS queued_wakeup
     FROM tasks i
     JOIN projects p ON p.id = i.project_id
     JOIN teams co ON co.id = i.team_id
     LEFT JOIN members m ON m.id = i.assignee_id
     LEFT JOIN member_agents ma ON ma.id = i.assignee_id
     LEFT JOIN members m_ps ON m_ps.id = i.progress_summary_updated_by
     LEFT JOIN member_agents ma_ps ON ma_ps.id = i.progress_summary_updated_by
     LEFT JOIN LATERAL (
       SELECT w.last_skipped_reason, w.last_skipped_at, w.last_skipped_blocker_task_id,
              b.identifier AS blocker_identifier,
              bp.slug AS blocker_project_slug
       FROM agent_wakeup_requests w
       LEFT JOIN tasks b ON b.id = w.last_skipped_blocker_task_id
       LEFT JOIN projects bp ON bp.id = b.project_id
       WHERE w.member_id = i.assignee_id
         AND w.payload->>'task_id' = i.id::text
         AND w.status = 'queued'
         AND w.last_skipped_at IS NOT NULL
       ORDER BY w.last_skipped_at DESC
       LIMIT 1
     ) qw ON true
     LEFT JOIN LATERAL (
       SELECT hr.id AS run_id, hr.status, hrc.id AS comment_id, hrc.public_id AS comment_public_id
       FROM heartbeat_runs hr
       LEFT JOIN task_comments hrc
         ON hrc.task_id = hr.task_id
         AND hrc.content_type = 'run'
         AND hrc.content->>'run_id' = hr.id::text
       WHERE hr.task_id = i.id
         AND hr.status NOT IN ('queued', 'running')
       ORDER BY hr.finished_at DESC NULLS LAST, hr.started_at DESC
       LIMIT 1
     ) lr ON true
     WHERE i.id = $1 AND i.team_id = $2`,
		[taskId, teamId],
	);

	if (result.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Task not found', 404);
	}

	return ok(c, result.rows[0]);
});

tasksRoutes.post('/projects/:projectId/tasks/resolve', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');

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

tasksRoutes.get('/projects/:projectId/tasks/:taskId/latest-run', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
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

tasksRoutes.patch('/projects/:projectId/tasks/:taskId', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
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

	const scopeDenied = assertRunTaskScope(auth, taskId, body.status);
	if (scopeDenied) return err(c, 'FORBIDDEN', scopeDenied, 403);

	if (
		body.status !== undefined &&
		auth.type === AuthType.Agent &&
		existing.rows[0].status === TaskStatus.Closed
	) {
		return err(c, 'FORBIDDEN', 'Only the admin can re-open a closed task', 403);
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
	const events = c.get('events');
	const actorType = actorTypeFromAuth(c.get('auth'));
	const projectId = existing.rows[0].project_id;

	if (body.description !== undefined) {
		trackBackground(
			recordTaskLinks(
				db,
				teamId,
				taskId,
				body.description,
				actorMemberId,
				c.get('wsManager'),
			).catch((e) => log.error('Failed to record task links from description:', e)),
		);
	}

	if (body.title !== undefined) {
		try {
			await recordTitleChange(
				db,
				teamId,
				taskId,
				existing.rows[0].title,
				body.title.trim(),
				actorMemberId,
				c.get('wsManager'),
			);
			events?.emit({
				type: 'task.updated',
				teamId,
				projectId,
				actorType,
				actorMemberId,
				taskId,
				field: 'title',
				from: existing.rows[0].title,
				to: body.title.trim(),
			});
		} catch (e) {
			log.error('Failed to record title change:', e);
		}
	}

	if (body.assignee_id !== undefined && body.assignee_id !== existing.rows[0].assignee_id) {
		try {
			const names = await recordAssigneeChange(
				db,
				teamId,
				taskId,
				existing.rows[0].assignee_id,
				body.assignee_id,
				actorMemberId,
				c.get('wsManager'),
			);
			events?.emit({
				type: 'task.updated',
				teamId,
				projectId,
				actorType,
				actorMemberId,
				taskId,
				field: 'assignee',
				from: existing.rows[0].assignee_id,
				to: body.assignee_id,
				fromLabel: names?.fromName ?? null,
				toLabel: names?.toName ?? null,
			});
		} catch (e) {
			log.error('Failed to record assignee change:', e);
		}
	}

	if (body.status) {
		try {
			await triggerStatusAutomations(
				db,
				teamId,
				taskId,
				existing.rows[0].status,
				body.status,
				actorMemberId,
				c.get('wsManager'),
			);
		} catch (e) {
			log.error('Failed to trigger status automations:', e);
		}

		{
			const newStatus = (result.rows[0] as Record<string, unknown>).status as string;
			if (newStatus !== existing.rows[0].status) {
				events?.emit({
					type: 'task.updated',
					teamId,
					projectId,
					actorType,
					actorMemberId,
					taskId,
					field: 'status',
					from: existing.rows[0].status,
					to: newStatus,
				});
			}
		}

		if (body.status === TaskStatus.Closed || body.status === TaskStatus.Cancelled) {
			const terminateReason = `Task ${body.status}`;
			trackBackground(
				terminateRunsForTask(
					{
						db,
						wsManager: c.get('wsManager'),
						jobManager: c.get('jobManager'),
					},
					taskId,
					terminateReason,
					actorMemberId,
				).catch((e) => log.error('Failed to terminate runs on task close:', e)),
			);
		}

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
							removeTaskWorktrees(dataDir, locator.teamId, locator.id, taskInfo.identifier);
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

tasksRoutes.post('/projects/:projectId/tasks/:taskId/sub-tasks', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
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
			c.get('events'),
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

tasksRoutes.get('/projects/:projectId/tasks/:taskId/ancestors', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
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

tasksRoutes.get('/projects/:projectId/tasks/:taskId/dependencies', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const taskId = await resolveTaskId(db, teamId, c.req.param('taskId'));
	if (!taskId) return err(c, 'NOT_FOUND', 'Task not found', 404);

	const result = await db.query(
		`SELECT d.id, d.task_id, d.blocked_by_task_id, d.created_at,
            i.identifier AS blocked_by_identifier, i.title AS blocked_by_title, i.status AS blocked_by_status,
            p.slug AS blocked_by_project_slug,
            EXISTS (
              SELECT 1 FROM heartbeat_runs hr
              WHERE hr.task_id = i.id AND hr.status IN ('running', 'queued')
            ) AS blocked_by_has_active_run,
            CASE WHEN qw.last_skipped_reason IS NOT NULL THEN json_build_object(
              'reason', qw.last_skipped_reason,
              'since', qw.last_skipped_at,
              'blocker_task_id', qw.last_skipped_blocker_task_id,
              'blocker_identifier', qw.blocker_identifier,
              'blocker_project_slug', qw.blocker_project_slug
            ) ELSE NULL END AS blocked_by_queued_wakeup
     FROM task_dependencies d
     JOIN tasks i ON i.id = d.blocked_by_task_id
     JOIN projects p ON p.id = i.project_id
     LEFT JOIN LATERAL (
       SELECT w.last_skipped_reason, w.last_skipped_at, w.last_skipped_blocker_task_id,
              b.identifier AS blocker_identifier,
              bp.slug AS blocker_project_slug
       FROM agent_wakeup_requests w
       LEFT JOIN tasks b ON b.id = w.last_skipped_blocker_task_id
       LEFT JOIN projects bp ON bp.id = b.project_id
       WHERE w.member_id = i.assignee_id
         AND w.payload->>'task_id' = i.id::text
         AND w.status = 'queued'
         AND w.last_skipped_at IS NOT NULL
       ORDER BY w.last_skipped_at DESC
       LIMIT 1
     ) qw ON true
     WHERE d.task_id = $1`,
		[taskId],
	);
	return ok(c, result.rows);
});

tasksRoutes.post('/projects/:projectId/tasks/:taskId/dependencies', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
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

tasksRoutes.delete('/projects/:projectId/tasks/:taskId/dependencies/:depId', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
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
