import { WakeupSource } from '@hezo/shared';
import type { Db } from '../db/database';
import { heartbeatIntervalFloorMin } from './heartbeat-schedule';

/**
 * Wakeup sources the no-work backoff never suppresses.
 *
 * Each is somebody asking this agent for something it could not have served on
 * its last pass: a human or teammate addressing it, an operator pressing "Run
 * now", a credential or asset decision it was parked on. The backoff exists to
 * stop the system re-asking a question it already answered, never to delay an
 * answer to a new one.
 *
 * The complement - `heartbeat`, `assignment`, `timer`, `automation` - is
 * everything the system raises on its own behalf, which is exactly what a
 * "nothing to do" verdict is about.
 */
export const NO_WORK_BACKOFF_EXEMPT_SOURCES: ReadonlySet<string> = new Set([
	WakeupSource.Mention,
	WakeupSource.Comment,
	WakeupSource.Reply,
	WakeupSource.OnDemand,
	WakeupSource.CredentialProvided,
	WakeupSource.AssetDeletionResolved,
]);

/**
 * Would dispatching this agent onto this task re-run a no-op it just finished?
 *
 * `report_no_work` is the agent stating that this task has nothing for it yet.
 * That verdict was recorded on the run row and then never read again, so any
 * wakeup arriving afterwards - and four of the ten sources fire on system state
 * changes nobody chose - dispatched a fresh container, a fresh model call and a
 * fresh bill to reach the identical conclusion. The agent's configured cadence
 * did not help: it is honoured only by `processScheduledHeartbeats` and
 * `chainNextTaskWakeup`, so a 24-hour agent could still run every few minutes.
 *
 * This is the missing half - the verdict applied at dispatch, for every source.
 * Three conditions, all required:
 *
 * 1. The agent's most recent finished run on this task ended in `report_no_work`.
 *    A run that did work, failed, or timed out says nothing about whether there
 *    is work now.
 * 2. That run finished within the agent's own heartbeat interval (floored the
 *    same way the scheduler floors it). The window is the cadence the operator
 *    chose, so the backoff expires exactly when a scheduled heartbeat would have
 *    come round anyway - it delays nothing that was going to happen sooner.
 * 3. Nothing has landed on the task since. Every change that could give the
 *    agent something to do - a human or teammate comment, a status flip, a
 *    reassignment, a retitle, an unblock - writes a `task_comments` row through
 *    `services/task-events.ts`, so one check covers all of them. Comments the
 *    run itself authored are excluded; they are the run reporting, not new input.
 *
 * Deliberately reads comments rather than `tasks.updated_at`: a run bumps its
 * own task's `updated_at` when it flips the status to in_progress, so that
 * column reports "changed" on the quietest possible run and the backoff would
 * never engage.
 *
 * One round trip. Returns false for a task-less wakeup (nothing to be idle
 * about) and for every exempt source.
 */
export async function noWorkCooldownActive(
	db: Db,
	memberId: string,
	taskId: string | null | undefined,
	source: string,
): Promise<boolean> {
	if (!taskId) return false;
	if (NO_WORK_BACKOFF_EXEMPT_SOURCES.has(source)) return false;

	const r = await db.query<{ cooldown: boolean }>(
		`WITH last_run AS (
		   SELECT hr.id, hr.finished_at, hr.reported_no_work
		   FROM heartbeat_runs hr
		   WHERE hr.member_id = $1 AND hr.task_id = $2 AND hr.finished_at IS NOT NULL
		   ORDER BY hr.finished_at DESC
		   LIMIT 1
		 )
		 SELECT (
		   lr.reported_no_work
		   AND lr.finished_at
		       + (GREATEST(ma.heartbeat_interval_min, $3::int) || ' minutes')::interval > now()
		   AND NOT EXISTS (
		     SELECT 1 FROM task_comments c
		     WHERE c.task_id = $2
		       AND c.created_at > lr.finished_at
		       AND (c.created_by_run_id IS NULL OR c.created_by_run_id <> lr.id)
		   )
		 ) AS cooldown
		 FROM last_run lr
		 JOIN member_agents ma ON ma.id = $1`,
		[memberId, taskId, heartbeatIntervalFloorMin()],
	);

	return r.rows[0]?.cooldown === true;
}
