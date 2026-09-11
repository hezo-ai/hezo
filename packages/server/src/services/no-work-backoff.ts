import { WakeupSkipReason, WakeupSource } from '@hezo/shared';
import type { Db } from '../db/database';
import { outstandingAdminAskExistsSql } from '../lib/task-sort';
import { heartbeatIntervalFloorMin } from './heartbeat-schedule';

/**
 * Wakeup sources neither dispatch suppression in this module ever applies to.
 *
 * Each is somebody asking this agent for something it could not have served on
 * its last pass: a human or teammate addressing it, an operator pressing "Run
 * now", a credential, asset or proposal decision it was parked on. The backoff
 * exists to stop the system re-asking a question it already answered, never to
 * delay an answer to a new one.
 *
 * The complement - `heartbeat`, `assignment`, `timer`, `automation` - is
 * everything the system raises on its own behalf, which is exactly what a
 * "nothing to do" verdict is about. A resolved hire or goal suggestion belongs
 * on this side of that line and rode `automation` until it had a source of its
 * own: an agent parked on a proposal it filed cannot serve the decision before
 * the admin has made it, so a "nothing to do" verdict from before the decision
 * says nothing about the run that must follow it.
 */
export const DISPATCH_SUPPRESSION_EXEMPT_SOURCES: ReadonlySet<string> = new Set([
	WakeupSource.Mention,
	WakeupSource.Comment,
	WakeupSource.Reply,
	WakeupSource.OnDemand,
	WakeupSource.CredentialProvided,
	WakeupSource.AssetDeletionResolved,
	WakeupSource.ApprovalResolved,
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
 *    Answering a choice card writes no row - it sets `chosen_option` on the card
 *    already there - so `chosen_at` is read alongside `created_at`. Without it
 *    the single most conclusive "the wait is over" event on a thread is the one
 *    event this check cannot see.
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
	if (DISPATCH_SUPPRESSION_EXEMPT_SOURCES.has(source)) return false;

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
		   AND NOT EXISTS (
		     SELECT 1 FROM task_comments a
		     WHERE a.task_id = $2 AND a.chosen_at > lr.finished_at
		   )
		 ) AS cooldown
		 FROM last_run lr
		 JOIN member_agents ma ON ma.id = $1`,
		[memberId, taskId, heartbeatIntervalFloorMin()],
	);

	return r.rows[0]?.cooldown === true;
}

/**
 * Is this task parked on a human, with nothing said since?
 *
 * The mirror of the backoff above, for the other reason a dispatch bills a
 * container to reach a conclusion the last run already reached: the agent asked
 * the admin something it cannot answer itself and nobody has replied. The stop
 * judge already treats that as a legitimate place to stop, and `SHARED_INSTRUCTIONS`
 * already tells an agent not to re-engage a task sitting in someone else's court -
 * but nothing stopped the *scheduler* dispatching onto it anyway, so an unanswered
 * ask cost a full run every heartbeat until it was answered or the task was closed.
 *
 * Two conditions, both required:
 *
 * 1. An ask still stands on the thread - a comment that raised an admin-inbox row
 *    (a literal `@admin`, a `request_credential`) or an unanswered choice card.
 * 2. Nobody but this agent has spoken since that ask. Every change that could give
 *    the agent something new - a human or teammate comment, a status flip, a
 *    reassignment, an unblock - writes a `task_comments` row through
 *    `services/task-events.ts`, so the one check covers all of them. The agent's own
 *    later comments are excluded: chasing its own question is not an answer to it.
 *    An answered choice card counts as somebody speaking whoever authored the card,
 *    since the answer is the admin's; it writes no row, so `chosen_at` carries it.
 *    Folding it in only ever moves the cutoff later, which narrows the window an
 *    ask can stand in - this cannot park a task that was not already parked.
 *
 * Deliberately unbounded in time, unlike the no-work backoff. That one expires at
 * the agent's own cadence because "nothing to do *yet*" goes stale; this one is a
 * question addressed to a person, and it goes stale only when they answer. The
 * exempt sources above carry every form that answer can take, so the reply that
 * lifts this can never be blocked by it, and an operator can always force a pass
 * with "Run now" (`on_demand`).
 *
 * Over-suppression is possible and accepted: any `@admin` in a comment parks the
 * task, including one written inside a routine status update. The cost is a delayed
 * heartbeat on a thread whose last word was a question to a human; the escape
 * hatches above are one click and one reply.
 *
 * One round trip. Returns false for a task-less wakeup and for every exempt source.
 *
 * Kept as a sibling of {@link noWorkCooldownActive} rather than folded into its
 * query: migration 061's frozen comment names that function and this file, so
 * neither can be renamed to cover both, and one honest predicate each beats one
 * whose name describes half of what it does. Dispatch is per-wakeup, not per-row,
 * so the second round trip is affordable.
 */
export async function parkedOnAdminAsk(
	db: Db,
	memberId: string,
	taskId: string | null | undefined,
	source: string,
): Promise<boolean> {
	if (!taskId) return false;
	if (DISPATCH_SUPPRESSION_EXEMPT_SOURCES.has(source)) return false;

	// `newest_other` reads this task's comments through idx_comments_task_created
	// (task_id, created_at), filtering out the agent's own unanswered ones; the ask
	// probe is then bounded to the comments after it, which on a parked task is the
	// ask itself plus whatever the agent added. `GREATEST` ignores NULLs in
	// Postgres, so a card answered by the agent's own row still contributes its
	// `chosen_at` while its `created_at` is skipped.
	const r = await db.query<{ parked: boolean }>(
		`WITH newest_other AS (
		   SELECT max(GREATEST(
		            CASE WHEN c.author_member_id IS DISTINCT FROM $1 THEN c.created_at END,
		            c.chosen_at)) AS at
		   FROM task_comments c
		   WHERE c.task_id = $2
		     AND (c.author_member_id IS DISTINCT FROM $1 OR c.chosen_at IS NOT NULL)
		 )
		 SELECT EXISTS (
		   SELECT 1 FROM task_comments ask CROSS JOIN newest_other n
		   WHERE ask.task_id = $2
		     AND (n.at IS NULL OR ask.created_at > n.at)
		     AND ${outstandingAdminAskExistsSql('ask')}
		 ) AS parked`,
		[memberId, taskId],
	);

	return r.rows[0]?.parked === true;
}

/**
 * How long the dispatcher holds a wakeup the model provider just refused,
 * keyed by which refusal it was.
 *
 * Two clocks because the two clear on different ones. Capacity, overload and
 * rate limits are minutes-long and often seconds-long, so five minutes delays a
 * genuine blip barely at all while capping the cost at twelve laps an hour. A
 * spent subscription allowance resets on a multi-hour clock, so retrying it on
 * the capacity cadence would be twelve wasted container claims an hour for
 * hours - it gets thirty minutes instead.
 *
 * Both are judgement calls, not read from upstream: none of the runtimes
 * surfaces a `Retry-After` on its stream, so there is no value to honour. Not a
 * `runtimeConfig()` key - that would drag in the config schema, the defaults,
 * the deployment docs and an upgrade pass for a knob nobody asked to tune.
 * Tests reach these by back-dating `last_skipped_at`.
 */
const PROVIDER_REFUSAL_COOLDOWN_MIN: Record<string, number> = {
	[WakeupSkipReason.ProviderAtCapacity]: 5,
	[WakeupSkipReason.ProviderUsageLimit]: 30,
};

/**
 * A `WHERE` fragment excluding wakeups still cooling down after the provider
 * refused them.
 *
 * Written as SQL rather than as a predicate the dispatch loop calls, because
 * the wakeup scan is `ORDER BY created_at ASC LIMIT 10`: a cooling-down wakeup
 * is an *old* row, so filtering it after the scan would let a handful of them
 * occupy the whole window every tick and starve newer work. Excluding them in
 * the query removes them from the window instead.
 *
 * Reads `last_skipped_reason` / `last_skipped_at`, which the handback wrote and
 * which the claim clears - so this must be applied to the scan, before the
 * claim, and not where the two dispatch suppressions above are applied.
 *
 * Nothing is written per tick: the row is simply not selected, so its clock
 * keeps running from the handback's own timestamp and no unchanged row is
 * rewritten. The wakeup stays `queued` throughout, so the task keeps showing
 * its queued badge for the whole outage.
 *
 * Deliberately has no exempt sources, unlike the two suppressions above. A
 * human's mention or reply cannot change how loaded the provider is, so
 * dispatching for one would claim a container to fail again. "Run now"
 * (`dispatchWakeupNow`) selects by id and does not apply this, which is the
 * operator's override.
 */
export function providerRefusalCooldownSql(alias = ''): string {
	const col = (name: string) => (alias ? `${alias}.${name}` : name);
	const arms = Object.entries(PROVIDER_REFUSAL_COOLDOWN_MIN).map(
		([reason, minutes]) =>
			`(${col('last_skipped_reason')} = '${reason}' AND ${col('last_skipped_at')} > now() - interval '${minutes} minutes')`,
	);
	// `COALESCE(..., false)` is load-bearing, not defensive. A wakeup that has never
	// been skipped has a NULL `last_skipped_reason`, so every arm evaluates to NULL,
	// the OR is NULL, and a bare `NOT (NULL)` is NULL - which a WHERE treats as
	// false, silently filtering out every ordinary wakeup in the queue.
	return `NOT COALESCE(${arms.join(' OR ')}, false)`;
}
