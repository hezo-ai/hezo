import type { MessageKey } from './i18n';

/**
 * What a manual dispatch route answers with - "Run now" on a queued agent, and
 * Retry on a failed run. Both post to `queued-wakeups.ts` and share its outcome
 * table, so they share this shape.
 *
 * `queued` is the case that is not a failure: the wakeup row survived the guard
 * that declined it, and the wakeup cron starts the run as soon as that guard
 * clears. A route reports the wait's `reason`; the sentence naming it lives here
 * so it reaches the reader in their own language.
 */
export interface ManualDispatchResult {
	dispatched?: boolean;
	queued?: boolean;
	/** A hold the presser cannot lift refused the start; `reason` names it. */
	held?: boolean;
	wakeup_id?: string;
	reason?: string;
}

/**
 * The wait each queued reason describes. A reason this build does not recognise
 * still says the run is pending rather than falling silent - the row really is
 * queued whatever named the guard.
 */
const QUEUED_REASON_MESSAGE: Record<string, MessageKey> = {
	instance_at_capacity: 'tasks.dispatch.queued.instanceAtCapacity',
	hours_exhausted: 'tasks.dispatch.queued.hoursExhausted',
	task_busy: 'tasks.dispatch.queued.taskBusy',
	agent_busy: 'tasks.dispatch.queued.agentBusy',
};

export function queuedDispatchMessageKey(reason: string | undefined): MessageKey {
	return (reason && QUEUED_REASON_MESSAGE[reason]) || 'tasks.dispatch.queued.fallback';
}

/** Why a hold refused a manual start, by the route's `reason`. */
const HELD_REASON_MESSAGE: Record<string, MessageKey> = {
	held: 'tasks.dispatch.held.task',
	over_budget: 'tasks.dispatch.held.overBudget',
};

export function heldDispatchMessageKey(reason: string | undefined): MessageKey {
	return (reason && HELD_REASON_MESSAGE[reason]) || 'tasks.dispatch.held.task';
}

/** The notice for a manual dispatch that did not start a run, or null when it did. */
export function manualDispatchNoticeKey(data: ManualDispatchResult): MessageKey | null {
	if (data.held) return heldDispatchMessageKey(data.reason);
	if (data.queued) return queuedDispatchMessageKey(data.reason);
	return null;
}
