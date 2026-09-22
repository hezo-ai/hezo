import { HeartbeatRunKind, HeartbeatRunStatus, RunCancelReason, WakeupSource } from '@hezo/shared';
import type { Db } from '../db/database';
import { outstandingAdminAskExistsSql } from '../lib/task-sort';
import { heartbeatIntervalFloorMin } from './heartbeat-schedule';

/**
 * Wakeup sources that can carry somebody asking this agent for something it
 * could not have served on its last pass: a human or teammate addressing it, an
 * operator pressing "Run now", a credential, asset or proposal decision it was
 * parked on. The backoff exists to stop the system re-asking a question it
 * already answered, never to delay an answer to a new one.
 *
 * The complement - `heartbeat`, `assignment`, `timer`, `automation` - is
 * everything the system raises on its own behalf, which is exactly what a
 * "nothing to do" verdict is about. A resolved hire or goal suggestion belongs
 * on this side of that line and rode `automation` until it had a source of its
 * own: an agent parked on a proposal it filed cannot serve the decision before
 * the admin has made it, so a "nothing to do" verdict from before the decision
 * says nothing about the run that must follow it.
 *
 * A source on this list is necessary, not sufficient: the conversational ones
 * below are raised by agents as often as by people, so whether one wakeup is
 * exempt is decided by {@link dispatchSuppressionExempt}.
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
 * The sources one agent hands a task to another through: a comment on its task,
 * an @-mention, a reply. A person uses the same three, which is why neither the
 * source nor the wakeup's run attribution alone says who is asking.
 */
export const CONVERSATIONAL_SOURCES: ReadonlySet<string> = new Set([
	WakeupSource.Mention,
	WakeupSource.Comment,
	WakeupSource.Reply,
]);

/**
 * SQL for when a person last spoke on a task: a comment they wrote, or a choice
 * they made on a card. The second stamps `chosen_at` on the card's own row,
 * usually an agent's, so reading authorship alone would miss it. NULL when no
 * person has spoken. Read through `idx_comments_task_created`.
 */
export function personSpokeAtSql(taskParam: string): string {
	return `(SELECT max(GREATEST(
	           CASE WHEN c.author_user_id IS NOT NULL THEN c.created_at END,
	           c.chosen_at))
	    FROM task_comments c
	   WHERE c.task_id = ${taskParam}
	     AND (c.author_user_id IS NOT NULL OR c.chosen_at IS NOT NULL))`;
}

/**
 * Does this wakeup skip every dispatch suppression in this module?
 *
 * Yes for an operator override ("Run now", Retry), which stamps `triggered_by`
 * on the payload whatever the wakeup's source, and for a decision a person made
 * (a credential, an asset deletion, an approval).
 *
 * A conversational wakeup is exempt when no agent run raised it, or when a
 * person has spoken on the task since this agent last ran on it - a comment they
 * wrote or a choice they made on a card. A queued wakeup absorbs later triggers
 * and keeps the first agent's attribution through them, so an attributed row may
 * still carry a person's words; the thread says whether it does. An agent's own
 * mention or reply is exempt from nothing: before this rule it bypassed every
 * hold, which is how two agents handed one task back and forth for a day while a
 * retrospective hold stood on it.
 */
export async function dispatchSuppressionExempt(
	db: Db,
	memberId: string,
	taskId: string | null | undefined,
	source: string,
	payload: Record<string, unknown> | undefined,
	wakeupId: string | null | undefined,
): Promise<boolean> {
	if (payload?.triggered_by) return true;
	if (!DISPATCH_SUPPRESSION_EXEMPT_SOURCES.has(source)) return false;
	if (!CONVERSATIONAL_SOURCES.has(source) || !taskId) return true;

	const r = await db.query<{ exempt: boolean }>(
		`SELECT (
		   NOT EXISTS (
		     SELECT 1 FROM agent_wakeup_requests w
		      WHERE w.id = $3 AND w.created_by_run_id IS NOT NULL
		   )
		   OR ${personSpokeAtSql('$2')} > COALESCE(
		        (SELECT max(started_at) FROM heartbeat_runs WHERE task_id = $2 AND member_id = $1),
		        '-infinity')
		 ) AS exempt`,
		[memberId, taskId, wakeupId ?? null],
	);
	return r.rows[0]?.exempt === true;
}

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
 * about) and for an exempt one.
 */
export async function noWorkCooldownActive(
	db: Db,
	memberId: string,
	taskId: string | null | undefined,
	exempt: boolean,
): Promise<boolean> {
	if (!taskId || exempt) return false;

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
 * question addressed to a person, and it goes stale only when they answer. A
 * person's answer is an exempt wakeup, and a teammate's comment lifts the park
 * itself, so the reply that lifts this can never be blocked by it, and an
 * operator can always force a pass with "Run now" (`on_demand`).
 *
 * Over-suppression is possible and accepted: any `@admin` in a comment parks the
 * task, including one written inside a routine status update. The cost is a delayed
 * heartbeat on a thread whose last word was a question to a human; the escape
 * hatches above are one click and one reply.
 *
 * One round trip. Returns false for a task-less wakeup and for an exempt one.
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
	exempt: boolean,
): Promise<boolean> {
	if (!taskId || exempt) return false;

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
 * How long the dispatcher holds a wakeup after the model provider refused its run
 * for capacity, overload or a rate limit.
 *
 * These clear on a minutes-long clock and often a seconds-long one, so five
 * minutes delays a genuine blip barely at all while capping the cost at twelve
 * laps an hour. A spent subscription allowance is held on the credential instead,
 * until the time the provider states (see `provider-credential-health.ts`).
 *
 * A judgement call, not read from upstream: none of the runtimes surfaces a
 * `Retry-After` on its stream. Not a `runtimeConfig()` key - that would drag in
 * the config schema, the defaults, the deployment docs and an upgrade pass for a
 * knob nobody asked to tune.
 */
export const PROVIDER_CAPACITY_COOLDOWN_MIN = 5;

/**
 * How many unproductive attempts on one task, inside
 * {@link TASK_ATTEMPT_WINDOW_HOURS}, before the dispatcher stops handing this
 * agent that task.
 *
 * Six, against the observed shape of the fault: a task that genuinely needs two
 * or three retries is untouched, while one that cannot finish inside its run
 * window parks instead of spending a full provider allowance per attempt for as
 * long as nobody is watching.
 */
export const MAX_TASK_ATTEMPT_GIVEUPS = 6;

/** The rolling window the count above is taken over. */
export const TASK_ATTEMPT_WINDOW_HOURS = 24;

/**
 * Endings that count as "this attempt produced nothing".
 *
 * `operator_terminated` and `work_withdrawn` are deliberately absent: a person
 * pressing Terminate twice must not park their own task. That is the same
 * judgement `NON_PINGING_STATUSES` encodes for failure pings.
 */
const UNPRODUCTIVE_CANCEL_REASONS: readonly string[] = [
	RunCancelReason.HandedBack,
	RunCancelReason.Abandoned,
];

/**
 * Has this agent given up on this task too many times to keep being handed it?
 *
 * The third dispatch suppression, and the one that bounds total work rather than
 * repetition. Its siblings ask whether a *fresh* pass would reach a conclusion
 * the last one already reached; this one asks whether the agent has stopped
 * being able to finish at all.
 *
 * It lives here, beside them, rather than in the timeout-continuation path,
 * because the continuation is one wakeup source out of ten. A task that times
 * out repeatedly is also woken by `heartbeat`, `assignment` and `automation`,
 * none of which consulted the continuation cap - so bounding that one caller
 * bounded almost nothing.
 *
 * **Only a success resets the count.** Counting *consecutive* endings of one
 * kind is what failed before: a give-up that finalizes `cancelled` (a capacity
 * park, a credential wait, a provider refusal) broke a timeout streak and handed
 * the task a fresh allowance, so a task alternating between the two never hit any
 * cap. Progress is the only thing that should buy more attempts.
 */
export async function attemptsExhaustedOnTask(
	db: Db,
	memberId: string,
	taskId: string | null | undefined,
	exempt: boolean,
): Promise<boolean> {
	if (!taskId || exempt) return false;

	// Served by idx (member_id, task_id, finished_at DESC) from migration 061.
	const r = await db.query<{ attempts: string }>(
		`WITH last_success AS (
		   SELECT max(finished_at) AS at FROM heartbeat_runs
		   WHERE member_id = $1 AND task_id = $2
		     AND status = $3::heartbeat_run_status
		 )
		 SELECT count(*) AS attempts
		 FROM heartbeat_runs r CROSS JOIN last_success s
		 WHERE r.member_id = $1 AND r.task_id = $2
		   AND r.finished_at IS NOT NULL
		   AND r.finished_at > now() - ($4 || ' hours')::interval
		   AND (s.at IS NULL OR r.finished_at > s.at)
		   AND (
		     r.status = ANY($5::heartbeat_run_status[])
		     OR (r.status = $6::heartbeat_run_status AND r.cancel_reason = ANY($7::text[]))
		   )`,
		[
			memberId,
			taskId,
			HeartbeatRunStatus.Succeeded,
			String(TASK_ATTEMPT_WINDOW_HOURS),
			[HeartbeatRunStatus.Failed, HeartbeatRunStatus.TimedOut],
			HeartbeatRunStatus.Cancelled,
			[...UNPRODUCTIVE_CANCEL_REASONS],
		],
	);
	return Number(r.rows[0]?.attempts ?? 0) >= MAX_TASK_ATTEMPT_GIVEUPS;
}

/**
 * Has a retrospective flagged this task, with nobody having answered since?
 *
 * The fourth suppression applied after task resolution, and the only one raised by a
 * third party rather than by the agent's own last run. The Coach's retrospective looks across a project
 * for work that is not converging; when it finds some, reporting it is not enough.
 * An `@admin` comment raises an Inbox row and reorders the task list, but it
 * suppresses no dispatches at all, so the loop it just described would carry on
 * spending while the notice sat unread. This is what makes the report a brake.
 *
 * Two conditions:
 *
 * 1. A comment on this task was written by a retrospective run. That attribution is
 *    the whole signal - it comes off `created_by_run_id`, which the schema already
 *    carries, so there is no label to keep in step and no phrase to match.
 * 2. No **person** has spoken since. An agent replying to the finding does not clear
 *    it; the question was addressed to a human, which is where this parts company
 *    with {@link parkedOnAdminAsk}, where any other member counts. A person speaks
 *    two ways and both are read: a comment they authored, and a choice they made on
 *    a card. The second stamps `chosen_at` on the **agent's** row rather than
 *    writing one of their own, so testing authorship alone would miss it.
 *
 * Deliberately unbounded in time, like {@link parkedOnAdminAsk}: a judgement handed
 * to a person goes stale when they answer, not on a clock. A person's answer is an
 * exempt wakeup whatever form it takes, and "Run now" is always the operator's
 * override.
 *
 * Returns false for a task-less wakeup and for an exempt one.
 */
export async function retrospectiveHoldActive(
	db: Db,
	_memberId: string,
	taskId: string | null | undefined,
	exempt: boolean,
): Promise<boolean> {
	if (!taskId || exempt) return false;

	const r = await db.query<{ held: boolean }>(
		`WITH finding AS (
		   SELECT max(c.created_at) AS at
		     FROM task_comments c
		     JOIN heartbeat_runs r ON r.id = c.created_by_run_id
		    WHERE c.task_id = $1 AND r.kind = $2::heartbeat_run_kind
		 )
		 SELECT (
		   f.at IS NOT NULL
		   AND COALESCE(${personSpokeAtSql('$1')} <= f.at, true)
		 ) AS held
		 FROM finding f`,
		[taskId, HeartbeatRunKind.Retrospective],
	);
	return r.rows[0]?.held === true;
}

/**
 * How many rounds in a row agents may hand one task to each other before every
 * agent is held off it until a person speaks.
 *
 * Eight, from eleven days of production runs: it holds the two-agent loop that
 * spent most of a week's provider allowance on one task, and it interrupts no
 * task that went on to finish.
 */
export const HANDOFF_ROUND_LIMIT = 8;

/**
 * How many of a task's newest runs the count reads. Several runs can share one
 * wakeup, so the window is wider than the limit, and it caps the cost of the
 * query on a task with a long history.
 */
const HANDOFF_SCAN_RUNS = HANDOFF_ROUND_LIMIT * 8;

/** The system comment kind that tells the admin a task is held by the handoff limit. */
export const HANDOFF_LIMIT_COMMENT_KIND = 'handoff_limit';

/** A task held by {@link handoffRoundsExhausted}, as the notice to the admin states it. */
export interface HandoffRounds {
	/** Consecutive agent-to-agent rounds since a person last spoke. */
	rounds: number;
	/** Input (cache included) plus output across those rounds' runs. */
	tokens: number;
	/** The agents that ran those rounds. */
	agentSlugs: string[];
	/** Whether the task already carries a notice for this hold. */
	notified: boolean;
}

/**
 * SQL: CTEs ending in `chain`, the runs of the current agent-to-agent handoff
 * chain on task `$1`. Binds `$2` the conversational sources, `$3` the handed-back
 * cancel reason and `$4` the scan limit, in {@link handoffChainParams} order.
 */
const HANDOFF_CHAIN_CTES = `person AS (SELECT ${personSpokeAtSql('$1')} AS at),
		 recent AS (
		   SELECT r.wakeup_id, r.member_id, r.started_at,
		          r.input_tokens + r.output_tokens AS tokens,
		          COALESCE(
		            w.source::text = ANY($2::text[])
		            AND w.created_by_run_id IS NOT NULL
		            AND w.payload->'triggered_by' IS NULL,
		            false) AS handoff
		     FROM heartbeat_runs r
		     CROSS JOIN person p
		     LEFT JOIN agent_wakeup_requests w ON w.id = r.wakeup_id
		    WHERE r.task_id = $1
		      AND r.started_at IS NOT NULL
		      AND (p.at IS NULL OR r.started_at > p.at)
		      AND r.cancel_reason IS DISTINCT FROM $3
		    ORDER BY r.started_at DESC
		    LIMIT $4
		 ),
		 chain AS (
		   SELECT * FROM recent
		    WHERE handoff
		      AND started_at > COALESCE(
		            (SELECT max(started_at) FROM recent WHERE NOT handoff), '-infinity')
		 )`;

/** The bind values {@link HANDOFF_CHAIN_CTES} reads, in order. */
function handoffChainParams(taskId: string): unknown[] {
	return [taskId, [...CONVERSATIONAL_SOURCES], RunCancelReason.HandedBack, HANDOFF_SCAN_RUNS];
}

/** What a task has used so far, as the Current Task block states it to the agent. */
export interface TaskUsageSoFar {
	/** Runs that started on the task. */
	runs: number;
	/** Input (cache included) plus output across those runs. */
	tokens: number;
	/** Consecutive agent-to-agent handoff rounds, the count {@link handoffRoundsExhausted} holds at. */
	handoffRounds: number;
}

/**
 * What a task has used so far: its runs, their tokens, and the current handoff
 * chain. One round trip, reading runs through `idx_runs_task_started`.
 */
export async function loadTaskUsageSoFar(db: Db, taskId: string): Promise<TaskUsageSoFar> {
	const r = await db.query<{ runs: number; tokens: number; rounds: number }>(
		`WITH ${HANDOFF_CHAIN_CTES}
		 SELECT count(*)::int AS runs,
		        COALESCE(sum(r.input_tokens + r.output_tokens), 0)::float8 AS tokens,
		        (SELECT count(DISTINCT wakeup_id)::int FROM chain) AS rounds
		   FROM heartbeat_runs r
		  WHERE r.task_id = $1 AND r.started_at IS NOT NULL`,
		handoffChainParams(taskId),
	);
	const row = r.rows[0];
	return {
		runs: row?.runs ?? 0,
		tokens: row?.tokens ?? 0,
		handoffRounds: row?.rounds ?? 0,
	};
}

/**
 * Have agents handed this task back and forth too many times without a person?
 *
 * A round is a run whose wakeup an agent's comment, mention or reply raised - a
 * conversational source with `created_by_run_id` set and no operator
 * `triggered_by`. Rounds are read newest first and counted by distinct wakeup;
 * a handed-back run did no work and is skipped. The count restarts at the first
 * run anything else started (an assignment, a heartbeat, a timer, "Run now"),
 * and whenever a person speaks on the task: a comment they wrote, or a choice
 * they made on a card.
 *
 * At the limit the whole task is held, for every agent and every non-exempt
 * source, until a person speaks - the rule {@link retrospectiveHoldActive}
 * uses. {@link parkedOnAdminAsk} would lift the moment the other agent replied,
 * which in a two-agent loop is at once, and every other bound here keys on a
 * failure signal that a loop of successful runs never raises.
 *
 * Returns the rounds when the task is held, and null otherwise. One round trip,
 * reading runs through `idx_runs_task_started`.
 */
export async function handoffRoundsExhausted(
	db: Db,
	taskId: string | null | undefined,
	exempt: boolean,
): Promise<HandoffRounds | null> {
	if (!taskId || exempt) return null;

	const r = await db.query<{
		rounds: string;
		tokens: string;
		agent_slugs: string[] | null;
		notified: boolean;
	}>(
		`WITH ${HANDOFF_CHAIN_CTES}
		 SELECT count(DISTINCT ch.wakeup_id) AS rounds,
		        COALESCE(sum(ch.tokens), 0) AS tokens,
		        array_agg(DISTINCT ma.slug) FILTER (WHERE ma.slug IS NOT NULL) AS agent_slugs,
		        ${noticePostedSinceSql('$1', '$5', '(SELECT max(started_at) FROM chain)')} AS notified
		   FROM chain ch
		   LEFT JOIN member_agents ma ON ma.id = ch.member_id`,
		[...handoffChainParams(taskId), HANDOFF_LIMIT_COMMENT_KIND],
	);
	const row = r.rows[0];
	const rounds = Number(row?.rounds ?? 0);
	if (rounds < HANDOFF_ROUND_LIMIT) return null;
	return {
		rounds,
		tokens: Number(row.tokens),
		agentSlugs: row.agent_slugs ?? [],
		notified: row.notified,
	};
}

/** SQL: whether a system notice of `kindParam` was posted on the task after `sinceExpr`. */
function noticePostedSinceSql(taskParam: string, kindParam: string, sinceExpr: string): string {
	return `EXISTS (
	   SELECT 1 FROM task_comments n
	    WHERE n.task_id = ${taskParam}
	      AND n.content_type = 'system'::comment_content_type
	      AND n.content->>'kind' = ${kindParam}
	      AND n.created_at > ${sinceExpr})`;
}

/** The notice a task held by the handoff limit carries, for `postAdminNotice`. */
export function handoffLimitNotice(
	h: HandoffRounds,
): { kind: string; text: string } & Record<string, unknown> {
	const agents = h.agentSlugs.map((slug) => `@${slug}`).join(', ');
	return {
		kind: HANDOFF_LIMIT_COMMENT_KIND,
		rounds: h.rounds,
		tokens: h.tokens,
		agent_slugs: h.agentSlugs,
		text: `${agents} handed this task to each other ${h.rounds} times in a row, using ${h.tokens.toLocaleString('en-US')} tokens. No agent will run on it until a person replies.`,
	};
}

/**
 * The most tokens agents may spend on one task - input with cached input, plus
 * output, across every run - before a person must say to carry on.
 *
 * 100 million, from eleven days of production runs: it would have held the
 * two-agent loop at its eleventh run instead of its forty-sixth. Finished tasks
 * reached up to 100 million there, so the largest of them would have asked once
 * near its end.
 */
export const TASK_TOKEN_CEILING = 100_000_000;

/** The system comment kind that tells the admin a task reached its token ceiling. */
export const TASK_TOKEN_CEILING_COMMENT_KIND = 'task_token_ceiling';

/** A task held by {@link taskTokenCeilingReached}, as the notice to the admin states it. */
export interface TaskTokenUsage {
	/** Tokens its runs used since a person last spoke on it. */
	tokens: number;
	/** Whether the task already carries a notice for this hold. */
	notified: boolean;
}

/**
 * Have agents spent more on this task than anyone agreed to, with nobody asked?
 *
 * Sums the tokens of every run on the task that started after a person last
 * spoke on it. At {@link TASK_TOKEN_CEILING} the task is held for every agent
 * and every non-exempt source until a person speaks, and that reply grants a
 * fresh ceiling - the count starts again from it. A bound on total work rather
 * than on a shape of it, so it holds whatever the loop looks like: a handoff
 * chain broken by a heartbeat, one agent re-running itself, a review that never
 * converges.
 *
 * Returns the usage when the task is held, and null otherwise. One round trip,
 * reading runs through `idx_runs_task_started`.
 */
export async function taskTokenCeilingReached(
	db: Db,
	taskId: string | null | undefined,
	exempt: boolean,
): Promise<TaskTokenUsage | null> {
	if (!taskId || exempt) return null;
	const r = await db.query<{ tokens: number; notified: boolean }>(
		`WITH person AS (SELECT ${personSpokeAtSql('$1')} AS at)
		 SELECT COALESCE(sum(r.input_tokens + r.output_tokens), 0)::float8 AS tokens,
		        ${noticePostedSinceSql('$1', '$2', "COALESCE((SELECT at FROM person), '-infinity')")} AS notified
		   FROM heartbeat_runs r CROSS JOIN person p
		  WHERE r.task_id = $1
		    AND r.started_at IS NOT NULL
		    AND (p.at IS NULL OR r.started_at > p.at)`,
		[taskId, TASK_TOKEN_CEILING_COMMENT_KIND],
	);
	const row = r.rows[0];
	if (!row || row.tokens < TASK_TOKEN_CEILING) return null;
	return { tokens: row.tokens, notified: row.notified };
}

/** The notice a task held by its token ceiling carries, for `postAdminNotice`. */
export function taskTokenCeilingNotice(
	u: TaskTokenUsage,
): { kind: string; text: string } & Record<string, unknown> {
	return {
		kind: TASK_TOKEN_CEILING_COMMENT_KIND,
		tokens: u.tokens,
		ceiling: TASK_TOKEN_CEILING,
		text: `Agents have used ${u.tokens.toLocaleString('en-US')} tokens on this task since a person last replied, past its ceiling of ${TASK_TOKEN_CEILING.toLocaleString('en-US')}. No agent will run on it until a person replies.`,
	};
}
