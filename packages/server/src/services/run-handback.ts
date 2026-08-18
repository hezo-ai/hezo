import { type HeartbeatRunStatus, RunCancelReason } from '@hezo/shared';
import type { Db } from '../db/database';
import { logger } from '../logger';
import { recordRunAbandoned } from './task-events';
import type { WebSocketManager } from './ws';

const log = logger.child('run-handback');

/**
 * What became of the work a run was carrying when it ended without doing it.
 *
 * `abandoned` is the one outcome that leaves work owed with nothing carrying it,
 * which is why it is named rather than folded into `escalated`: it is what the
 * run row, the Retry affordance and the thread notice all key off.
 */
export type HandbackOutcome = 'requeued' | 'replaced' | 'escalated' | 'abandoned';

/**
 * What happened to the work, in the operator's terms.
 *
 * A table rather than a branch, so a new outcome is a compile error here until
 * someone writes the sentence for it. Every sentence names a state the reader
 * can see for themselves: the queue, the Inbox, the Retry button.
 */
export const HANDBACK_OUTCOME_COPY: Record<HandbackOutcome, string> = {
	requeued: 'The work is back in the queue and will be picked up automatically.',
	replaced: 'A fresh run has been queued to pick this work back up.',
	escalated:
		'Hezo has stopped retrying this and asked for a human. There is a pending item in your Inbox.',
	abandoned:
		'Nothing was left to put back on the queue, so this will not restart on its own. ' +
		'Use Retry to run it again.',
};

/**
 * The cancel attribution each outcome earns, for the outcomes that produce a
 * `cancelled` row. `escalated` belongs to the process-loss arm, which finalizes
 * `failed` and carries its cause in the error rather than a cancel reason.
 */
const OUTCOME_CANCEL_REASON: Record<HandbackOutcome, RunCancelReason | null> = {
	requeued: RunCancelReason.HandedBack,
	replaced: RunCancelReason.HandedBack,
	escalated: null,
	abandoned: RunCancelReason.Abandoned,
};

export interface HandbackRunContext {
	runId: string;
	taskId: string | null;
	teamId: string;
	agentSlug: string | null;
	/** The status this writer put on the row, so a later writer's verdict is not overwritten. */
	terminalStatus: HeartbeatRunStatus;
}

/**
 * Record on the run row what actually became of its work, **after** it is known.
 *
 * The one home for the second half of a handback, shared by the orphan sweeper
 * and the run-completion path. They had it in one place and not the other, which
 * is how the completion path came to stamp `handed_back` before attempting the
 * handback and then leave it standing when the handback failed - a row asserting
 * the work was queued while nothing carried it, which is the whole defect this
 * area exists to prevent.
 *
 * Returns whether the write applied. Two guards, and both matter. The status
 * guard means a terminate or a container sweep landing in between keeps its own
 * more specific record, so the caller must not broadcast a row it did not write.
 * The `cancel_reason IS NULL` guard makes first-writer-wins structural rather
 * than per-column: a human pressing Terminate backfills `operator_terminated`
 * while the abort is still cascading, and neither the attribution, the appended
 * sentence nor the thread notice may land on top of that. Whoever stopped the
 * run is the authority on why, and this writer is never that party.
 */
export async function recordHandbackOutcome(
	db: Db,
	run: HandbackRunContext,
	outcome: HandbackOutcome,
	/** Full replacement text. Omit to append the outcome sentence to what is there. */
	error: string | undefined,
	wsManager: WebSocketManager | undefined,
): Promise<boolean> {
	const applied = await db.query<{ id: string }>(
		`UPDATE heartbeat_runs
		    SET error = COALESCE($1, trim(both from COALESCE(error, '') || ' ' || $5)),
		        cancel_reason = COALESCE(cancel_reason, $4)
		  WHERE id = $2 AND status = $3::heartbeat_run_status
		    AND cancel_reason IS NULL
		 RETURNING id`,
		[
			error ?? null,
			run.runId,
			run.terminalStatus,
			OUTCOME_CANCEL_REASON[outcome],
			HANDBACK_OUTCOME_COPY[outcome],
		],
	);
	if (applied.rows.length === 0) return false;

	// The only outcome a reader has to do something about, so the only one worth a
	// row in the thread. Everything else either re-runs on its own or was
	// somebody's own decision to stop. Posted only once the write above applied,
	// so the notice can never point at a run whose row says something else.
	if (outcome === 'abandoned' && run.taskId) {
		await recordRunAbandoned(db, run.teamId, run.taskId, run.runId, run.agentSlug, wsManager).catch(
			(e) => log.error(`Failed to post abandoned-run notice for run ${run.runId}:`, e),
		);
	}
	return true;
}
