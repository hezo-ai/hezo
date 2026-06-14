import type { PGlite } from '@electric-sql/pglite';
import { type AuditActorType, TaskPriority, TaskStatus, WakeupSource, wsRoom } from '@hezo/shared';
import type { DomainEventBus } from '../events/bus';
import { assertSubordinateAssignee } from '../lib/assignment-hierarchy';
import { trackBackground } from '../lib/background';
import { broadcastRowChange } from '../lib/broadcast';
import { hasOpenBlockers, wouldCreateCycle } from '../lib/dependencies';
import { resolveTaskId } from '../lib/resolve';
import { withTransaction } from '../lib/sql';
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
	events?: DomainEventBus,
): Promise<TaskRow> {
	const title = input.title?.trim();
	if (!input.project_id || !title) {
		throw new CreateTaskError('INVALID_REQUEST', 'project_id and title are required');
	}

	// A parent may be referenced by identifier (e.g. "BE-2") or UUID, like every
	// other task reference in the API. Resolve to a UUID before the depth check
	// and INSERT — an unresolved identifier would otherwise reach the uuid column
	// and surface as an opaque "invalid input syntax for type uuid" internal error.
	let parentTaskId: string | null = null;
	if (input.parent_task_id) {
		parentTaskId = await resolveTaskId(db, teamId, input.parent_task_id);
		if (!parentTaskId) {
			throw new CreateTaskError('NOT_FOUND', `Parent task '${input.parent_task_id}' not found`);
		}
		const depthCheck = await assertChildDepthAllowed(db, teamId, parentTaskId);
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

	if (caller.agentMemberId) {
		const subordinateCheck = await assertSubordinateAssignee(db, caller.agentMemberId, assigneeId);
		if (!subordinateCheck.ok) {
			throw new CreateTaskError('FORBIDDEN', subordinateCheck.message);
		}
	}

	// Identifier allocation, the insert, and blocker attachment must land
	// atomically — a rejected blocker reference would otherwise leave an
	// orphan task row behind.
	const task = await withTransaction(db, async () => {
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
				parentTaskId,
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
		let created = r.rows[0];

		if (input.blocked_by_task_ids?.length) {
			await attachBlockers(db, teamId, created.id, input.blocked_by_task_ids);
			if (await hasOpenBlockers(db, created.id)) {
				const updated = await db.query<typeof created>(
					'UPDATE tasks SET status = $1::task_status WHERE id = $2 RETURNING *',
					[TaskStatus.Blocked, created.id],
				);
				if (updated.rows[0]) created = updated.rows[0];
			}
		}
		return created;
	});

	const isAgent = await db.query('SELECT id FROM member_agents WHERE id = $1', [assigneeId]);
	if (isAgent.rows.length > 0) {
		trackBackground(
			createWakeup(db, assigneeId, teamId, WakeupSource.Assignment, {
				task_id: task.id,
			}).catch((e) => log.error('Failed to create wakeup for assignment:', e)),
		);
	}

	broadcastRowChange(wsManager, wsRoom.team(teamId), 'tasks', 'INSERT', task);

	events?.emit({
		type: 'task.created',
		teamId,
		projectId: input.project_id,
		actorType: caller.actorType,
		actorMemberId: caller.actorMemberId,
		taskId: task.id,
		identifier: task.identifier,
	});

	if (input.description) {
		trackBackground(
			recordTaskLinks(
				db,
				teamId,
				task.id,
				input.description,
				caller.actorMemberId,
				wsManager,
			).catch((e) => log.error('Failed to record task links from description:', e)),
		);
	}

	return task;
}

export type CreateTaskBatchResult =
	| { index: number; ok: true; task: TaskRow }
	| { index: number; ok: false; error: string; code: CreateTaskErrorCode | 'INTERNAL_ERROR' };

// Matches a reference to an earlier item in the same batch by zero-based
// index (e.g. "#0"). Cannot collide with task identifiers (PREFIX-number)
// or UUIDs, neither of which starts with '#'.
const BATCH_INDEX_TOKEN_RE = /^#(0|[1-9]\d*)$/;

/**
 * Create a set of tasks in input order, continuing past per-item failures.
 * Within the batch, `blocked_by_task_ids` entries and `parent_task_id` may
 * reference an earlier item by zero-based index token (`'#0'` = first item);
 * the token is substituted with that item's UUID before creation. Tokens that
 * are malformed, self/forward-referencing, or point at a failed item error
 * that item without aborting the rest.
 */
export async function createTaskBatch(
	db: PGlite,
	teamId: string,
	items: CreateTaskInput[],
	caller: CreateTaskCaller,
	wsManager: WebSocketManager | undefined,
	events?: DomainEventBus,
): Promise<CreateTaskBatchResult[]> {
	const results: CreateTaskBatchResult[] = [];
	const createdIds: (string | null)[] = [];

	for (let index = 0; index < items.length; index++) {
		const item = items[index];
		try {
			const blocked_by_task_ids = resolveBatchBlockerRefs(
				item.blocked_by_task_ids,
				index,
				createdIds,
			);
			const parent_task_id = resolveBatchParentRef(item.parent_task_id, index, createdIds);
			const task = await createTask(
				db,
				teamId,
				{ ...item, blocked_by_task_ids, parent_task_id },
				caller,
				wsManager,
				events,
			);
			createdIds.push(task.id);
			results.push({ index, ok: true, task });
		} catch (e) {
			createdIds.push(null);
			if (e instanceof CreateTaskError) {
				results.push({ index, ok: false, error: e.message, code: e.code });
			} else {
				log.error('Unexpected error in batch task creation:', e);
				results.push({
					index,
					ok: false,
					error: e instanceof Error ? e.message : 'internal_error',
					code: 'INTERNAL_ERROR',
				});
			}
		}
	}

	return results;
}

// Resolve a single '#<index>' batch token to the referenced item's UUID,
// enforcing that it points at an earlier, successfully-created item. Shared by
// the blocker-list and parent resolvers so both report identical errors.
function resolveBatchIndexRef(
	trimmed: string,
	index: number,
	createdIds: readonly (string | null)[],
): string {
	const match = BATCH_INDEX_TOKEN_RE.exec(trimmed);
	if (!match) {
		throw new CreateTaskError(
			'INVALID_REQUEST',
			`Invalid batch reference '${trimmed}' — use '#<zero-based index>' of an earlier item in this call`,
		);
	}
	const ref = Number(match[1]);
	if (ref >= index) {
		throw new CreateTaskError(
			'INVALID_REQUEST',
			`'${trimmed}' must reference an earlier item in this batch (this is item ${index})`,
		);
	}
	const refId = createdIds[ref];
	if (!refId) {
		throw new CreateTaskError(
			'INVALID_REQUEST',
			`'${trimmed}' references item ${ref}, which failed to create`,
		);
	}
	return refId;
}

function resolveBatchBlockerRefs(
	rawIds: readonly string[] | undefined,
	index: number,
	createdIds: readonly (string | null)[],
): string[] | undefined {
	if (!rawIds?.length) return rawIds as string[] | undefined;
	return rawIds.map((raw) => {
		const trimmed = typeof raw === 'string' ? raw.trim() : '';
		if (!trimmed.startsWith('#')) return raw;
		return resolveBatchIndexRef(trimmed, index, createdIds);
	});
}

// A batch item's parent may also use a '#<index>' token to nest under an earlier
// item in the same call (e.g. file a parent then its sub-tasks in one batch).
// Non-token values (identifier or UUID) pass through to createTask, which
// resolves them.
function resolveBatchParentRef(
	raw: string | undefined,
	index: number,
	createdIds: readonly (string | null)[],
): string | undefined {
	if (typeof raw !== 'string') return raw;
	const trimmed = raw.trim();
	if (!trimmed.startsWith('#')) return raw;
	return resolveBatchIndexRef(trimmed, index, createdIds);
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
