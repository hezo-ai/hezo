import type { PGlite } from '@electric-sql/pglite';
import {
	AuditAction,
	type AuditActorType,
	AuditEntityType,
	TaskPriority,
	TaskStatus,
	WakeupSource,
	wsRoom,
} from '@hezo/shared';
import { assertSubordinateAssignee } from '../lib/assignment-hierarchy';
import { auditLog } from '../lib/audit';
import { broadcastRowChange } from '../lib/broadcast';
import { hasOpenBlockers, wouldCreateCycle } from '../lib/dependencies';
import { assertOperationsAssignee } from '../lib/operations-assignee';
import { resolveTaskId } from '../lib/resolve';
import { allocateTaskIdentifier } from '../lib/task-identifier';
import { assertChildDepthAllowed } from '../lib/task-relationships';
import { logger } from '../logger';
import { recordTaskLinks } from './task-events';
import { createWakeup } from './wakeup';
import type { WebSocketManager } from './ws';

const log = logger.child('tasks-service');

// Bare projection of the tasks table — excludes the 384-dim embedding vector
// that would otherwise inflate every response by ~4 KB of JSON noise the
// caller can't use. Shared by REST handlers, MCP tools, and this service.
export const TASK_COLUMNS_BARE = `id, team_id, project_id, assignee_id, parent_task_id,
	created_by_member_id, created_by_run_id,
	number, identifier, title, description, rules,
	status, priority, labels,
	progress_summary, progress_summary_updated_at, progress_summary_updated_by,
	branch_name, runtime_type,
	created_at, updated_at`;

export interface CreateTaskInput {
	project_id: string;
	title: string;
	description?: string;
	assignee_id?: string;
	assignee_slug?: string;
	parent_task_id?: string;
	priority?: string;
	labels?: string[];
	runtime_type?: string;
	blocked_by_task_ids?: string[];
}

export interface CreateTaskCaller {
	actorType: AuditActorType;
	actorMemberId: string | null;
	// Set only when the caller is an agent run — drives the subordinate
	// assignee check and is recorded as created_by_run_id on the new task.
	agentMemberId?: string;
	runId?: string;
}

export type CreateTaskErrorCode = 'INVALID_REQUEST' | 'NOT_FOUND' | 'FORBIDDEN';

export class CreateTaskError extends Error {
	readonly code: CreateTaskErrorCode;
	constructor(code: CreateTaskErrorCode, message: string) {
		super(message);
		this.code = code;
		this.name = 'CreateTaskError';
	}
}

export type TaskRow = Record<string, unknown> & { id: string; identifier: string };

export async function createTask(
	db: PGlite,
	teamId: string,
	input: CreateTaskInput,
	caller: CreateTaskCaller,
	wsManager: WebSocketManager | undefined,
): Promise<TaskRow> {
	const title = input.title?.trim();
	if (!input.project_id || !title) {
		throw new CreateTaskError('INVALID_REQUEST', 'project_id and title are required');
	}

	if (input.parent_task_id) {
		const depthCheck = await assertChildDepthAllowed(db, teamId, input.parent_task_id);
		if (!depthCheck.ok) {
			throw new CreateTaskError('INVALID_REQUEST', depthCheck.message);
		}
	}

	let assigneeId = input.assignee_id;
	if (!assigneeId && input.assignee_slug) {
		const r = await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE ma.slug = $1 AND m.team_id = $2`,
			[input.assignee_slug, teamId],
		);
		if (r.rows.length === 0) {
			throw new CreateTaskError('NOT_FOUND', `Agent with slug '${input.assignee_slug}' not found`);
		}
		assigneeId = r.rows[0].id;
	}
	if (!assigneeId) {
		throw new CreateTaskError('INVALID_REQUEST', 'Either assignee_id or assignee_slug is required');
	}

	const opsCheck = await assertOperationsAssignee(db, teamId, input.project_id, assigneeId);
	if (!opsCheck.ok) {
		throw new CreateTaskError('INVALID_REQUEST', opsCheck.message);
	}

	if (caller.agentMemberId) {
		const subordinateCheck = await assertSubordinateAssignee(db, caller.agentMemberId, assigneeId);
		if (!subordinateCheck.ok) {
			throw new CreateTaskError('FORBIDDEN', subordinateCheck.message);
		}
	}

	const { number: taskNumber, identifier } = await allocateTaskIdentifier(db, input.project_id);

	const r = await db.query<TaskRow>(
		`INSERT INTO tasks (team_id, project_id, assignee_id, parent_task_id,
		                     created_by_member_id, created_by_run_id,
		                     number, identifier, title, description,
		                     status, priority, labels, runtime_type)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
		         $11::task_status, $12::task_priority, $13::jsonb, $14::agent_runtime)
		 RETURNING ${TASK_COLUMNS_BARE}`,
		[
			teamId,
			input.project_id,
			assigneeId,
			input.parent_task_id ?? null,
			caller.actorMemberId,
			caller.runId ?? null,
			taskNumber,
			identifier,
			title,
			input.description ?? '',
			TaskStatus.Backlog,
			input.priority ?? TaskPriority.Medium,
			JSON.stringify(input.labels ?? []),
			input.runtime_type ?? null,
		],
	);
	let task = r.rows[0];

	if (input.blocked_by_task_ids?.length) {
		await attachBlockers(db, teamId, task.id, input.blocked_by_task_ids);
		if (await hasOpenBlockers(db, task.id)) {
			const updated = await db.query<typeof task>(
				'UPDATE tasks SET status = $1::task_status WHERE id = $2 RETURNING *',
				[TaskStatus.Blocked, task.id],
			);
			if (updated.rows[0]) task = updated.rows[0];
		}
	}

	const isAgent = await db.query('SELECT id FROM member_agents WHERE id = $1', [assigneeId]);
	if (isAgent.rows.length > 0) {
		createWakeup(db, assigneeId, teamId, WakeupSource.Assignment, {
			task_id: task.id,
		}).catch((e) => log.error('Failed to create wakeup for assignment:', e));
	}

	broadcastRowChange(wsManager, wsRoom.team(teamId), 'tasks', 'INSERT', task);

	auditLog(
		db,
		teamId,
		caller.actorType,
		caller.actorMemberId,
		AuditAction.Created,
		AuditEntityType.Task,
		task.id,
		{ identifier },
	).catch((e) => log.error('Failed to write audit log for task creation:', e));

	if (input.description) {
		recordTaskLinks(db, teamId, task.id, input.description, caller.actorMemberId, wsManager).catch(
			(e) => log.error('Failed to record task links from description:', e),
		);
	}

	return task;
}

async function attachBlockers(
	db: PGlite,
	teamId: string,
	taskId: string,
	rawIds: readonly string[],
): Promise<void> {
	const seen = new Set<string>();
	for (const raw of rawIds) {
		const trimmed = typeof raw === 'string' ? raw.trim() : '';
		if (!trimmed) continue;
		const blockerId = await resolveTaskId(db, teamId, trimmed);
		if (!blockerId) {
			throw new CreateTaskError('NOT_FOUND', `Blocking task '${trimmed}' not found`);
		}
		if (blockerId === taskId) {
			throw new CreateTaskError('INVALID_REQUEST', 'An task cannot block itself');
		}
		if (seen.has(blockerId)) continue;
		seen.add(blockerId);
		if (await wouldCreateCycle(db, taskId, blockerId)) {
			throw new CreateTaskError(
				'INVALID_REQUEST',
				`Adding ${trimmed} as a blocker would create a dependency cycle`,
			);
		}
		await db.query(
			`INSERT INTO task_dependencies (task_id, blocked_by_task_id)
			 VALUES ($1, $2) ON CONFLICT DO NOTHING`,
			[taskId, blockerId],
		);
	}
}
