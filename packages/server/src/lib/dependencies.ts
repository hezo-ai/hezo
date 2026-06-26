import type { PGlite } from '@electric-sql/pglite';
import {
	HeartbeatRunStatus,
	TaskStatus,
	TERMINAL_TASK_STATUSES,
	WakeupSource,
	WakeupStatus,
	wsRoom,
} from '@hezo/shared';
import { logger } from '../logger';
import { type CascadeContext, recordStatusChange } from '../services/task-events';
import { createWakeup } from '../services/wakeup';
import type { WebSocketManager } from '../services/ws';
import { broadcastRowChange } from './broadcast';

const log = logger.child('dependencies');

/**
 * Wakeup sources that auto-fire on system state changes and should respect
 * dependency gates. User-initiated and conversational sources (mentions,
 * comments, option/credential responses, automations) are not in this set —
 * humans or peers explicitly poking an agent reach it even on a blocked
 * ticket.
 */
export const GATED_WAKEUP_SOURCES: ReadonlySet<string> = new Set([
	WakeupSource.Assignment,
	WakeupSource.Heartbeat,
	WakeupSource.Timer,
]);

/**
 * Decide whether a wakeup targeting `taskId` should be parked in the
 * deferred state because the target ticket has open blockers. Returns false
 * when the source bypasses the gate, the wakeup has no specific task
 * target, or the task itself is already in a terminal status (post-hoc
 * runs like Coach review on Done must always proceed).
 */
export async function shouldDeferWakeupForBlockers(
	db: PGlite,
	source: string,
	taskId: string | null | undefined,
): Promise<boolean> {
	if (!GATED_WAKEUP_SOURCES.has(source)) return false;
	if (!taskId) return false;
	const statusRow = await db.query<{ status: string }>('SELECT status FROM tasks WHERE id = $1', [
		taskId,
	]);
	const status = statusRow.rows[0]?.status;
	if (status && (TERMINAL_TASK_STATUSES as readonly string[]).includes(status)) return false;
	return hasOpenBlockers(db, taskId);
}

/**
 * True when `taskId` has at least one blocker whose status is not terminal.
 * A blocker is satisfied when the upstream task reaches `done` or `cancelled`.
 * Anything else (backlog, in_progress, review, blocked) leaves the downstream
 * gated.
 */
export async function hasOpenBlockers(db: PGlite, taskId: string): Promise<boolean> {
	const terminalPlaceholders = TERMINAL_TASK_STATUSES.map((_, i) => `$${i + 2}::task_status`).join(
		', ',
	);
	const r = await db.query(
		`SELECT 1
		 FROM task_dependencies d
		 JOIN tasks b ON b.id = d.blocked_by_task_id
		 WHERE d.task_id = $1
		   AND b.status NOT IN (${terminalPlaceholders})
		 LIMIT 1`,
		[taskId, ...TERMINAL_TASK_STATUSES],
	);
	return r.rows.length > 0;
}

/**
 * True when adding an edge `taskId blocked_by blockerId` would create a
 * cycle in the existing dependency graph. Runs a recursive CTE that walks
 * the existing blockers of `blockerId`; if `taskId` appears in that chain
 * (or `blockerId === taskId`), the new edge would close the loop.
 */
export async function wouldCreateCycle(
	db: PGlite,
	taskId: string,
	blockerId: string,
): Promise<boolean> {
	if (taskId === blockerId) return true;
	const r = await db.query(
		`WITH RECURSIVE chain AS (
		   SELECT blocked_by_task_id AS id FROM task_dependencies WHERE task_id = $1
		   UNION
		   SELECT d.blocked_by_task_id FROM task_dependencies d
		   JOIN chain c ON c.id = d.task_id
		 )
		 SELECT 1 FROM chain WHERE id = $2 LIMIT 1`,
		[blockerId, taskId],
	);
	return r.rows.length > 0;
}

/**
 * Walk the downstream side of the dependency graph for `blockerTaskId` and
 * reconcile each downstream's status against its current blocker state, then
 * wake any that just became unblocked. Used on both directions of upstream
 * status transitions (terminal entry/exit) and on direct dependency
 * mutations.
 *
 * For each downstream task whose blockers just cleared, `wakeIfReady`
 * flips an existing deferred wakeup back to `queued` if one exists;
 * otherwise it enqueues a fresh assignment-source wakeup with an
 * idempotency key keyed on the downstream task ID, so concurrent unblock
 * events don't fan out duplicate runs.
 */
export async function recomputeDownstreamReadiness(
	db: PGlite,
	teamId: string,
	blockerTaskId: string,
	actorMemberId: string | null,
	wsManager: WebSocketManager | undefined,
): Promise<void> {
	const downstream = await db.query<{ task_id: string }>(
		'SELECT DISTINCT task_id FROM task_dependencies WHERE blocked_by_task_id = $1',
		[blockerTaskId],
	);
	if (downstream.rows.length === 0) return;

	const blocker = await db.query<{ identifier: string; project_slug: string; status: string }>(
		`SELECT t.identifier, t.status, p.slug AS project_slug
		   FROM tasks t JOIN projects p ON p.id = t.project_id
		  WHERE t.id = $1`,
		[blockerTaskId],
	);
	const blockerRow = blocker.rows[0];
	const blockerTerminal =
		blockerRow !== undefined &&
		(TERMINAL_TASK_STATUSES as readonly string[]).includes(blockerRow.status);
	const cascade: CascadeContext | undefined =
		blockerRow && blockerTerminal
			? {
					kind: 'auto_unblock',
					triggeredByTaskId: blockerTaskId,
					triggeredByIdentifier: blockerRow.identifier,
					triggeredByProjectSlug: blockerRow.project_slug,
				}
			: undefined;

	for (const row of downstream.rows) {
		const newStatus = await reconcileBlockedStatus(
			db,
			teamId,
			row.task_id,
			actorMemberId,
			wsManager,
			cascade,
		);
		if (newStatus === TaskStatus.Backlog || newStatus === null) {
			await wakeIfReady(db, row.task_id);
		}
	}
}

/**
 * Coerce a requested status against the blocked-derivation invariant.
 * Terminal targets pass through unchanged. For non-terminal targets: if
 * the task has any open blocker, the target collapses to `blocked`;
 * if no open blockers remain and the caller asked for `blocked`, the
 * target collapses to `backlog` (since `blocked` is purely derived).
 */
export async function coerceTargetStatusForBlockers(
	db: PGlite,
	taskId: string,
	requested: string,
): Promise<string> {
	if ((TERMINAL_TASK_STATUSES as readonly string[]).includes(requested)) return requested;
	const blocked = await hasOpenBlockers(db, taskId);
	if (blocked) return TaskStatus.Blocked;
	if (requested === TaskStatus.Blocked) return TaskStatus.Backlog;
	return requested;
}

/**
 * Reconcile an task's stored status against its current blocker state.
 * Terminal tasks are never touched. Returns the new status when changed,
 * or null when no update was needed.
 */
export async function reconcileBlockedStatus(
	db: PGlite,
	teamId: string,
	taskId: string,
	actorMemberId: string | null,
	wsManager: WebSocketManager | undefined,
	cascade?: CascadeContext,
): Promise<string | null> {
	const r = await db.query<{ status: string }>('SELECT status FROM tasks WHERE id = $1', [taskId]);
	const current = r.rows[0]?.status;
	if (!current) return null;
	if ((TERMINAL_TASK_STATUSES as readonly string[]).includes(current)) return null;

	const blocked = await hasOpenBlockers(db, taskId);
	let target: string | null = null;
	if (blocked && current !== TaskStatus.Blocked) target = TaskStatus.Blocked;
	else if (!blocked && current === TaskStatus.Blocked) target = TaskStatus.Backlog;
	if (!target) return null;

	const updated = await db.query<Record<string, unknown>>(
		'UPDATE tasks SET status = $1::task_status, updated_at = NOW() WHERE id = $2 RETURNING *',
		[target, taskId],
	);
	const row = updated.rows[0];
	if (!row) return null;

	const effectiveCascade = target === TaskStatus.Backlog ? cascade : undefined;
	await recordStatusChange(
		db,
		teamId,
		taskId,
		current,
		target,
		actorMemberId,
		null,
		wsManager,
		effectiveCascade,
	);
	broadcastRowChange(wsManager, wsRoom.team(teamId), 'tasks', 'UPDATE', row);
	return target;
}

/**
 * Wake the assignee for a single downstream task if it no longer has any
 * open blockers. Splits out so callers that already know the task ID (e.g.
 * REST `DELETE /dependencies/:depId`) don't pay for the downstream lookup.
 */
export async function wakeIfReady(db: PGlite, taskId: string): Promise<void> {
	if (await hasOpenBlockers(db, taskId)) return;

	const task = await db.query<{ assignee_id: string | null; team_id: string }>(
		'SELECT assignee_id, team_id FROM tasks WHERE id = $1',
		[taskId],
	);
	const row = task.rows[0];
	if (!row?.assignee_id) return;

	const isAgent = await db.query('SELECT id FROM member_agents WHERE id = $1', [row.assignee_id]);
	if (isAgent.rows.length === 0) return;

	const flipped = await db.query<{ id: string }>(
		`UPDATE agent_wakeup_requests
		 SET status = $1::wakeup_status, claimed_at = NULL
		 WHERE member_id = $2
		   AND status = $3::wakeup_status
		   AND payload->>'task_id' = $4
		   AND payload->>'reason' = 'blocked'
		 RETURNING id`,
		[WakeupStatus.Queued, row.assignee_id, WakeupStatus.Deferred, taskId],
	);

	if (flipped.rows.length > 0) return;

	// If the assignee is already mid-run on this task, the running agent reads
	// the latest task state and serves the unblock — a fresh wakeup would just
	// queue a redundant follow-up behind the in-flight run.
	const activeRun = await db.query(
		`SELECT 1 FROM heartbeat_runs
		 WHERE member_id = $1 AND task_id = $2
		   AND status IN ($3::heartbeat_run_status, $4::heartbeat_run_status)
		 LIMIT 1`,
		[row.assignee_id, taskId, HeartbeatRunStatus.Queued, HeartbeatRunStatus.Running],
	);
	if (activeRun.rows.length > 0) return;

	try {
		await createWakeup(
			db,
			row.assignee_id,
			row.team_id,
			WakeupSource.Assignment,
			{ task_id: taskId, reason: 'unblocked' },
			`unblock:${taskId}`,
		);
	} catch (e) {
		log.error('Failed to create unblock wakeup:', e);
	}
}
