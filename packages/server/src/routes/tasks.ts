import {
	AuthType,
	TaskStatus,
	TERMINAL_TASK_STATUSES,
	taskStatusError,
	WakeupSource,
	wsRoom,
} from '@hezo/shared';
import { type Context, Hono } from 'hono';
import type { Db } from '../db/database';
import { readRunLogTail } from '../db/run-log-chunks';
import { agentDisplayNameSql } from '../lib/agent-identity';
import { assertSubordinateAssignee } from '../lib/assignment-hierarchy';
import { trackBackground } from '../lib/background';
import { broadcastChange } from '../lib/broadcast';
import {
	coerceTargetStatusForBlockers,
	reconcileBlockedStatus,
	wakeIfReady,
	wouldCreateCycle,
} from '../lib/dependencies';
import { buildMeta, parsePagination } from '../lib/pagination';
import { assertNoBlockingRun } from '../lib/reassign-guard';
import {
	actorTypeFromAuth,
	apiKeyIdFromAuth,
	resolveActorMemberId as resolveAuthActorMemberId,
	resolveTaskId,
} from '../lib/resolve';
import { err, ok } from '../lib/response';
import { assertRunTaskScope } from '../lib/run-scope';
import {
	assertChildrenAllClosed,
	assertNoOutstandingActivity,
	assertNoUnansweredAdminMentions,
	MAX_SUB_TASK_DEPTH,
	resolveParentAssignment,
} from '../lib/task-relationships';
import {
	adminActionPendingSql,
	adminUnreadMentionExistsSql,
	buildSearchRelevanceOrderSql,
	buildTaskListOrderBy,
	parseTaskListSort,
	taskActiveRunExistsSql,
} from '../lib/task-sort';
import type { Env } from '../lib/types';
import { logger } from '../logger';
import { cancelCoachWorkForTask, terminateRunsForTask } from '../services/run-termination';
import { triggerStatusAutomations, wakeTaskIfChildrenClosed } from '../services/task-automation';
import {
	emitTaskUpdateEvents,
	recordAssigneeChange,
	recordDescriptionChange,
	recordParentChange,
	recordTaskLinks,
	recordTitleChange,
	type TaskUpdateMutationRow,
	type TaskUpdateSnapshot,
	taskUpdateMutationSql,
	taskUpdateValueChanged,
} from '../services/task-events';
import {
	type CreateTaskCaller,
	CreateTaskError,
	type CreateTaskInput,
	createTask,
	createTaskBatch,
} from '../services/tasks';
import { createWakeup, wakeAgentIfAssigned } from '../services/wakeup';

const log = logger.child('routes');

const MAX_BATCH_TASKS = 50;

/**
 * Log excerpt returned with a task's latest run. The task view renders a
 * preview, not the whole log — the run page fetches that from its own endpoint.
 */
const LATEST_RUN_LOG_TAIL_CHARS = 64 * 1024;

/**
 * Outer bound on `heartbeat_runs.error` in a task projection.
 *
 * The column has no schema ceiling - a runner failure can carry a stack, the
 * orphan pass appends a log tail - and the client renders only its first line
 * (`runErrorSummary`). The single-run read serves the whole value.
 */
const LAST_RUN_ERROR_MAX_CHARS = 400;

async function buildCreateTaskCaller(c: Context<Env>, teamId: string): Promise<CreateTaskCaller> {
	const auth = c.get('auth');
	const actorMemberId = await resolveAuthActorMemberId(c.get('db'), auth, teamId);
	const caller: CreateTaskCaller = {
		actorType: actorTypeFromAuth(auth),
		actorMemberId,
		actorApiKeyId: apiKeyIdFromAuth(auth),
	};
	if (auth.type === AuthType.Agent) {
		caller.agentMemberId = auth.memberId;
		caller.runId = auth.runId ?? undefined;
	}
	return caller;
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
		for (const status of statuses) {
			const invalid = taskStatusError(status);
			if (invalid) return err(c, 'INVALID_REQUEST', invalid, 400);
		}
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
		conditions.push(
			`(i.title ILIKE $${idx} OR i.description ILIKE $${idx} OR i.identifier ILIKE $${idx})`,
		);
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

	// When searching, rank exact identifier / task-number matches ahead of tasks
	// that merely mention the term in their title or body, so "169" surfaces
	// HM-169 first instead of leaving it wherever the sort field happens to put
	// it. Relevance is the primary key; the chosen sort only breaks ties.
	let relevancePrefix = '';
	if (search) {
		const rel = buildSearchRelevanceOrderSql(search, params, idx);
		relevancePrefix = `${rel.sql} ASC, `;
		idx = rel.nextIdx;
	}

	// The viewing admin's id is read by both the projection and the ordering, so it
	// takes a placeholder of its own ahead of the ORDER BY params rather than being
	// appended after them.
	const adminUserIdx = idx;
	params.push(adminUserId);
	idx++;

	// One expression, two uses: the `admin_action_pending` column and the ordering
	// tier below active runs. Building it once keeps the two from drifting.
	const adminActionPending = adminActionPendingSql('i', adminUserIdx);

	const orderBy = buildTaskListOrderBy(sortField, sortDirection, params, idx, adminActionPending);
	idx = orderBy.nextIdx;

	const dataParams = [...params, perPage, offset];
	const result = await db.query(
		`SELECT i.id, i.team_id, i.project_id, i.assignee_id, i.parent_task_id,
            i.number, i.identifier, i.title, i.description, i.status, i.priority,
            i.labels, i.created_at, i.updated_at,
            p.name AS project_name,
            ${agentDisplayNameSql('ma', 'm')} AS assignee_name,
            ma.slug AS assignee_slug,
            m.member_type AS assignee_type,
            ${taskActiveRunExistsSql('i')} AS has_active_run,
            ${adminUnreadMentionExistsSql('i', adminUserIdx)} AS has_unread_admin_mention,
            ${adminActionPending} AS admin_action_pending,
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
     ORDER BY ${relevancePrefix}${orderBy.sql}
     LIMIT $${idx} OFFSET $${idx + 1}`,
		dataParams,
	);

	return c.json({ data: result.rows, meta: buildMeta(page, perPage, total) });
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
            ${agentDisplayNameSql('ma', 'm')} AS assignee_name,
            ma.slug AS assignee_slug,
            m.member_type AS assignee_type,
            ${agentDisplayNameSql('ma_ps', 'm_ps')} AS progress_summary_updated_by_name,
            (SELECT count(*)::int FROM task_comments ic WHERE ic.task_id = i.id) AS comment_count,
            ra.run_count, ra.total_duration_seconds, ca.total_cost_cents,
            (ar.status IS NOT NULL) AS has_active_run,
            CASE WHEN ar.status IS NOT NULL THEN json_build_object(
              'id', ar.id,
              'status', ar.status,
              'member_id', ar.member_id,
              'queued_reason', ar.queued_reason
            ) ELSE NULL END AS active_run,
            lr.status AS last_run_status,
            -- The thread folds a finished run open when there is something to act
            -- on, which for a cancelled run depends on why it was cancelled.
            lr.cancel_reason AS last_run_cancel_reason,
            left(lr.error, ${LAST_RUN_ERROR_MAX_CHARS}) AS last_run_error,
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
       SELECT hr.id AS run_id, hr.status, hr.error, hr.cancel_reason, hrc.id AS comment_id,
              hrc.public_id AS comment_public_id
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
     LEFT JOIN LATERAL (
       -- The task's current non-terminal run, preferring one that is actually
       -- executing over one still waiting to start, so the UI can label the two
       -- states apart instead of calling both "running".
       SELECT hr.id, hr.status, hr.member_id, hr.queued_reason
       FROM heartbeat_runs hr
       WHERE hr.task_id = i.id AND hr.status IN ('running', 'queued')
       ORDER BY (hr.status = 'running') DESC, hr.created_at DESC
       LIMIT 1
     ) ar ON true
     LEFT JOIN LATERAL (
       SELECT count(*) FILTER (WHERE hr.started_at IS NOT NULL)::int AS run_count,
              COALESCE(sum(
                EXTRACT(EPOCH FROM (hr.finished_at - hr.started_at))
              ) FILTER (WHERE hr.started_at IS NOT NULL AND hr.finished_at IS NOT NULL), 0)::int
                AS total_duration_seconds
       FROM heartbeat_runs hr
       WHERE hr.task_id = i.id
     ) ra ON true
     LEFT JOIN LATERAL (
       SELECT COALESCE(sum(ce.amount_cents), 0)::int AS total_cost_cents
       FROM cost_entries ce
       WHERE ce.task_id = i.id
     ) ca ON true
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

	const result = await db.query<{ id: string } & Record<string, unknown>>(
		`SELECT hr.id, hr.member_id, hr.status, hr.started_at, hr.finished_at,
		        hr.exit_code, hr.invocation_command, hr.working_dir,
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
	// The log is fetched separately as a bounded tail rather than joined in: a
	// run's log reaches 10 MB and this view renders an excerpt.
	const row = result.rows[0];
	const tail = await readRunLogTail(db, row.id, LATEST_RUN_LOG_TAIL_CHARS);
	return ok(c, { ...row, log_text: tail.text, log_length: tail.length });
});

tasksRoutes.patch('/projects/:projectId/tasks/:taskId', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const taskId = await resolveTaskId(db, teamId, c.req.param('taskId'));
	if (!taskId) return err(c, 'NOT_FOUND', 'Task not found', 404);

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
		parent_task_id?: string | null;
	}>();

	if (body.status !== undefined) {
		const invalid = taskStatusError(body.status);
		if (invalid) return err(c, 'INVALID_REQUEST', invalid, 400);
	}

	const auth = c.get('auth');

	const scopeDenied = assertRunTaskScope(auth, taskId, body.status);
	if (scopeDenied) return err(c, 'FORBIDDEN', scopeDenied, 403);

	// The progress summary is the agent's own running checkpoint, written from
	// inside a run via `update_task` and handed back to the next run in full. A
	// human rewriting it silently changes what that run believes about its own
	// work, so it is agent-only here; humans say what they want in a comment.
	if (body.progress_summary !== undefined && auth.type !== AuthType.Agent) {
		return err(
			c,
			'FORBIDDEN',
			'The progress summary is maintained by agents and cannot be edited by hand',
			403,
		);
	}
	if (body.branch_name === '') body.branch_name = null;

	const mutation = await db.transaction(async () => {
		const existing = await db.query<
			TaskUpdateSnapshot & {
				id: string;
				project_id: string;
			}
		>(
			`SELECT id, title, description, status, priority, project_id, assignee_id,
			        parent_task_id, progress_summary, rules, branch_name, runtime_type
			   FROM tasks WHERE id = $1 AND team_id = $2 FOR UPDATE`,
			[taskId, teamId],
		);
		if (existing.rows.length === 0) {
			return err(c, 'NOT_FOUND', 'Task not found', 404);
		}

		// `done` and `cancelled` are now the only terminal states; once a task is
		// terminal only the admin can move it back to an active status (re-open).
		if (
			body.status !== undefined &&
			body.status !== existing.rows[0].status &&
			auth.type === AuthType.Agent &&
			(TERMINAL_TASK_STATUSES as readonly string[]).includes(existing.rows[0].status)
		) {
			return err(c, 'FORBIDDEN', 'Only the admin can re-open a completed task', 403);
		}

		if (body.status === TaskStatus.Done && body.status !== existing.rows[0].status) {
			const childrenCheck = await assertChildrenAllClosed(db, teamId, taskId);
			if (!childrenCheck.ok) {
				return err(c, 'INVALID_REQUEST', childrenCheck.message, 400);
			}
		}
		if (body.status === TaskStatus.Done && body.status !== existing.rows[0].status) {
			const callerMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
			const activityCheck = await assertNoOutstandingActivity(db, taskId, callerMemberId);
			if (!activityCheck.ok) {
				return err(c, 'INVALID_REQUEST', activityCheck.message, 400);
			}
			// Agents cannot close over an unanswered @admin ask; a human closing
			// the task is itself the human's decision, so humans bypass this.
			if (callerMemberId !== null) {
				const adminAskCheck = await assertNoUnansweredAdminMentions(db, taskId);
				if (!adminAskCheck.ok) {
					return err(c, 'INVALID_REQUEST', adminAskCheck.message, 400);
				}
			}
		}

		if (body.status !== undefined) {
			body.status = await coerceTargetStatusForBlockers(db, taskId, body.status);
		}

		// `parent_task_id` is the one field on this route where an explicit null is
		// meaningful: null promotes the task to top level, a value nests it, and an
		// absent key leaves the parent alone. (Contrast `assignee_id` below, which
		// rejects null outright.)
		const oldParentTaskId = existing.rows[0].parent_task_id;
		let newParentTaskId: { value: string | null } | null = null;
		if (body.parent_task_id !== undefined) {
			const assignment = await resolveParentAssignment(
				db,
				teamId,
				{
					taskId,
					projectId: existing.rows[0].project_id,
					currentParentTaskId: oldParentTaskId,
					status: existing.rows[0].status,
				},
				body.parent_task_id,
			);
			if (!assignment.ok) {
				return err(
					c,
					assignment.code,
					assignment.message,
					assignment.code === 'NOT_FOUND' ? 404 : 400,
				);
			}
			if (assignment.changed) newParentTaskId = { value: assignment.parentTaskId };
		}

		const sets: string[] = [];
		const params: unknown[] = [];
		let idx = 1;

		if (
			body.title?.trim() !== undefined &&
			taskUpdateValueChanged(existing.rows[0], 'title', body.title.trim())
		) {
			sets.push(`title = $${idx}`);
			params.push(body.title.trim());
			idx++;
		}
		if (
			body.description !== undefined &&
			taskUpdateValueChanged(existing.rows[0], 'description', body.description)
		) {
			sets.push(`description = $${idx}`);
			params.push(body.description);
			idx++;
		}
		if (
			body.status !== undefined &&
			taskUpdateValueChanged(existing.rows[0], 'status', body.status)
		) {
			sets.push(`status = $${idx}::task_status`);
			params.push(body.status);
			idx++;
		}
		if (
			body.priority !== undefined &&
			taskUpdateValueChanged(existing.rows[0], 'priority', body.priority)
		) {
			sets.push(`priority = $${idx}::task_priority`);
			params.push(body.priority);
			idx++;
		}
		if (body.assignee_id !== undefined) {
			if (body.assignee_id === null) {
				return err(c, 'INVALID_REQUEST', 'assignee_id cannot be null', 400);
			}
			if (body.assignee_id !== existing.rows[0].assignee_id) {
				const blocking = await assertNoBlockingRun(db, taskId, {
					callerMemberId: auth.type === AuthType.Agent ? auth.memberId : null,
					incomingAssigneeId: body.assignee_id,
				});
				if (!blocking.ok) {
					return err(c, 'CONFLICT', blocking.message, 409);
				}
				// The MCP twin has always enforced this (`update_task` in mcp/tools.ts);
				// REST never did, because the unconditional run guard above incidentally
				// 409'd any agent reaching here from inside its own run. Exempting the
				// caller's own run opens that path, so the rule has to be stated here too
				// or an agent could dump its live task on a peer or its manager.
				if (auth.type === AuthType.Agent) {
					const hierarchy = await assertSubordinateAssignee(db, auth.memberId, body.assignee_id);
					if (!hierarchy.ok) {
						return err(c, 'FORBIDDEN', hierarchy.message, 403);
					}
				}
			}
			if (taskUpdateValueChanged(existing.rows[0], 'assignee_id', body.assignee_id)) {
				sets.push(`assignee_id = $${idx}`);
				params.push(body.assignee_id);
				idx++;
			}
		}
		if (newParentTaskId) {
			sets.push(`parent_task_id = $${idx}`);
			params.push(newParentTaskId.value);
			idx++;
		}
		if (body.labels !== undefined) {
			sets.push(`labels = $${idx}::jsonb`);
			params.push(JSON.stringify(body.labels));
			idx++;
		}
		if (
			body.progress_summary !== undefined &&
			taskUpdateValueChanged(existing.rows[0], 'progress_summary', body.progress_summary)
		) {
			sets.push(`progress_summary = $${idx}`);
			params.push(body.progress_summary);
			idx++;
			sets.push('progress_summary_updated_at = now()');
			// Only an agent reaches here — the guard above rejects every other caller.
			sets.push(`progress_summary_updated_by = $${idx}`);
			params.push(auth.type === AuthType.Agent ? auth.memberId : null);
			idx++;
		}
		if (body.rules !== undefined && taskUpdateValueChanged(existing.rows[0], 'rules', body.rules)) {
			sets.push(`rules = $${idx}`);
			params.push(body.rules);
			idx++;
		}
		if (
			body.branch_name !== undefined &&
			taskUpdateValueChanged(existing.rows[0], 'branch_name', body.branch_name)
		) {
			sets.push(`branch_name = $${idx}`);
			params.push(body.branch_name);
			idx++;
		}
		if (
			body.runtime_type !== undefined &&
			taskUpdateValueChanged(existing.rows[0], 'runtime_type', body.runtime_type)
		) {
			sets.push(`runtime_type = $${idx}::agent_runtime`);
			params.push(body.runtime_type);
			idx++;
		}

		if (sets.length === 0) {
			return { unchanged: existing.rows[0] };
		}

		params.push(taskId);
		const result = await db.query<TaskUpdateMutationRow>(taskUpdateMutationSql(sets, idx), params);
		return {
			mutationBefore: result.rows[0].before,
			updatedRow: result.rows[0].after,
			projectId: existing.rows[0].project_id,
		};
	});
	if (mutation instanceof Response) return mutation;
	if ('unchanged' in mutation) return ok(c, mutation.unchanged);
	const { mutationBefore, updatedRow, projectId } = mutation;

	// Every wakeup this write causes carries the run behind it, so that run's own
	// no-wake exit check can see whom it notified. An agent run reaches this route
	// with a run-scoped JWT, so this is not a human-only path.
	const callerRunId = auth.type === AuthType.Agent ? (auth.runId ?? null) : null;

	if (updatedRow.assignee_id && updatedRow.assignee_id !== mutationBefore.assignee_id) {
		// Awaited: the run's exit check reads this back at the end of the run.
		await wakeAgentIfAssigned(
			db,
			updatedRow.assignee_id,
			teamId,
			taskId,
			undefined,
			undefined,
			callerRunId,
		);
	}

	const wasTerminal = (TERMINAL_TASK_STATUSES as readonly string[]).includes(mutationBefore.status);
	const nowTerminal = (TERMINAL_TASK_STATUSES as readonly string[]).includes(updatedRow.status);
	if (mutationBefore.status !== updatedRow.status && wasTerminal && !nowTerminal) {
		await wakeAgentIfAssigned(
			db,
			mutationBefore.assignee_id,
			teamId,
			taskId,
			WakeupSource.Automation,
			{ trigger: 'task_reopened' },
			callerRunId,
		);
	}

	const actorMemberId = await resolveActorMemberId(c, teamId);
	const actorApiKeyId = apiKeyIdFromAuth(c.get('auth'));
	const events = c.get('events');
	const actorType = actorTypeFromAuth(c.get('auth'));

	if (taskUpdateValueChanged(mutationBefore, 'description', updatedRow.description)) {
		// `''` and NULL are the same "no description", so re-sending either over an
		// already-empty description is not an edit and records nothing. The recorder
		// applies the same rule; this guard keeps the no-op off the audit log too.
		if (updatedRow.description !== (mutationBefore.description ?? '')) {
			// Awaited: the client's onSettled invalidation refetches the comment feed
			// straight away and has to see this row (same reason as the rename below).
			try {
				await recordDescriptionChange(
					db,
					teamId,
					taskId,
					mutationBefore.description,
					updatedRow.description ?? '',
					actorMemberId,
					actorApiKeyId,
					c.get('wsManager'),
				);
				// The bodies deliberately stay off the audit row — a description has no
				// size ceiling, and the thread comment already carries bounded previews.
			} catch (e) {
				log.error('Failed to record description change:', e);
			}
		}

		trackBackground(
			recordTaskLinks(
				db,
				teamId,
				taskId,
				updatedRow.description ?? '',
				actorMemberId,
				actorApiKeyId,
				c.get('wsManager'),
			).catch((e) => log.error('Failed to record task links from description:', e)),
		);
	}

	if (taskUpdateValueChanged(mutationBefore, 'title', updatedRow.title)) {
		try {
			await recordTitleChange(
				db,
				teamId,
				taskId,
				mutationBefore.title,
				updatedRow.title,
				actorMemberId,
				actorApiKeyId,
				c.get('wsManager'),
			);
		} catch (e) {
			log.error('Failed to record title change:', e);
		}
	}

	if (mutationBefore.parent_task_id !== updatedRow.parent_task_id) {
		try {
			await recordParentChange(
				db,
				teamId,
				taskId,
				mutationBefore.parent_task_id,
				updatedRow.parent_task_id,
				actorMemberId,
				actorApiKeyId,
				c.get('wsManager'),
			);
		} catch (e) {
			log.error('Failed to record parent change:', e);
		}
		// Moving a task out clears the old parent's child-closure gate exactly as
		// closing it would, so the old parent's assignee gets the same wakeup. The
		// new parent gets nothing: gaining a child can only add an open child, never
		// clear a gate.
		if (mutationBefore.parent_task_id) {
			trackBackground(
				wakeTaskIfChildrenClosed(db, teamId, mutationBefore.parent_task_id, callerRunId).catch(
					(e) => log.error('Failed to wake former parent after re-parent:', e),
				),
			);
		}
	}

	if (updatedRow.assignee_id !== mutationBefore.assignee_id) {
		try {
			await recordAssigneeChange(
				db,
				teamId,
				taskId,
				mutationBefore.assignee_id,
				updatedRow.assignee_id,
				actorMemberId,
				actorApiKeyId,
				c.get('wsManager'),
			);
		} catch (e) {
			log.error('Failed to record assignee change:', e);
		}
	}

	if (mutationBefore.status !== updatedRow.status) {
		try {
			await triggerStatusAutomations(
				db,
				teamId,
				taskId,
				mutationBefore.status,
				updatedRow.status,
				actorMemberId,
				actorApiKeyId,
				c.get('wsManager'),
				c.get('dataDir'),
				callerRunId,
			);
		} catch (e) {
			log.error('Failed to trigger status automations:', e);
		}

		if (updatedRow.status === TaskStatus.Cancelled) {
			const terminateReason = `Task ${updatedRow.status}`;
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
				).catch((e) => log.error('Failed to terminate runs on task cancel:', e)),
			);
		}

		// Re-opening a terminal task (terminal → active) makes any pending Coach
		// review moot — retire its queued wakeup(s) and terminate any Coach run.
		if (wasTerminal && !nowTerminal) {
			trackBackground(
				cancelCoachWorkForTask(
					{
						db,
						wsManager: c.get('wsManager'),
						jobManager: c.get('jobManager'),
					},
					teamId,
					taskId,
					actorMemberId,
				).catch((e) => log.error('Failed to cancel Coach work on task re-open:', e)),
			);
		}

		// Worktree cleanup on a terminal transition now lives in
		// `triggerStatusAutomations` (above), so both this REST path and the MCP
		// `update_task` path prune closed tasks' worktrees consistently.
	}

	try {
		await emitTaskUpdateEvents(
			db,
			events,
			{ teamId, projectId, actorType, actorMemberId, actorApiKeyId, taskId },
			mutationBefore,
			updatedRow,
		);
	} catch (e) {
		log.error('Failed to emit task update events:', e);
	}

	broadcastChange(c, wsRoom.team(teamId), 'tasks', 'UPDATE', updatedRow);
	return ok(c, updatedRow);
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
		// Bounded by the depth cap rather than a literal, so raising the cap cannot
		// silently truncate a breadcrumb. The deepest legal task sits
		// MAX_SUB_TASK_DEPTH edges below its root, and every row shallower than the
		// cap recurses, so the walk reaches that root exactly.
		`WITH RECURSIVE chain AS (
			SELECT id, parent_task_id, identifier, title, 0 AS depth
			FROM tasks WHERE id = $1 AND team_id = $2
			UNION ALL
			SELECT i.id, i.parent_task_id, i.identifier, i.title, c.depth + 1
			FROM tasks i
			JOIN chain c ON c.parent_task_id = i.id
			WHERE i.team_id = $2 AND c.depth < $3
		)
		SELECT id, identifier, title, depth FROM chain ORDER BY depth DESC`,
		[taskId, teamId, MAX_SUB_TASK_DEPTH],
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
            ${taskActiveRunExistsSql('i')} AS blocked_by_has_active_run,
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
	const depAuth = c.get('auth');
	await wakeIfReady(db, taskId, depAuth.type === AuthType.Agent ? (depAuth.runId ?? null) : null);
	return c.json({ data: null }, 200);
});
