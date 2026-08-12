import { HeartbeatRunStatus } from '@hezo/shared';
import type { Db } from '../db/database';
import { agentDisplayNameSql } from './agent-identity';

export type BlockingRunCheck = { ok: true } | { ok: false; message: string };

/**
 * Who is moving the task, and where to. Both sides earn an exemption from the
 * run guard below, so both must be supplied by every caller.
 */
export interface ReassignActor {
	/**
	 * The agent making the call, or `null` for admin / API-key callers, which get
	 * no exemption.
	 *
	 * Keyed on the *member*, not on `auth.runId`, for two reasons. A stranded
	 * `queued` sibling row belonging to the same agent (see `.dev/architecture.md`
	 * § Stranded-run recovery, where one survives up to 120s) would otherwise
	 * re-create a narrower version of the deadlock this exemption exists to fix.
	 * And a CEO chat principal carries `runId: null`, so run-keying would give the
	 * operator's most likely hand for unsticking a wedged team no exemption at all.
	 * The trade is that a CEO chat turn can hand off a task the CEO's own task run
	 * is executing.
	 */
	callerMemberId: string | null;
	/** The resolved member UUID the task is moving to, or `null` when unknown. */
	incomingAssigneeId: string | null;
}

interface BlockingRun {
	slug: string | null;
	displayName: string;
	status: string;
}

export function reassignBlockedByRunError(blocker: BlockingRun): string {
	const who = blocker.slug ? `@${blocker.slug}` : blocker.displayName;
	const state =
		blocker.status === HeartbeatRunStatus.Queued
			? 'has a run queued on this task'
			: 'is running on this task';
	return (
		`Cannot change the assignee: ${who} ${state}, so this task is not yours to move. ` +
		`${who} can hand it over itself - a run is always free to reassign the task it is ` +
		`working on. Post a comment with an active ${who} mention asking for the handoff; ` +
		`that is what reaches them. Otherwise wait for the run to reach a terminal status, ` +
		`or cancel it from the task page. A run of your own, or one belonging to the agent ` +
		`you are assigning to, never blocks a reassignment.`
	);
}

/**
 * Reject a reassignment that would pull the task out from under a *third party's*
 * live run - one belonging to neither the caller nor the incoming assignee.
 *
 * Both exemptions matter. Without the caller exemption the guard is a deadlock:
 * an agent JWT only authenticates while its own run row is `running`
 * (`middleware/auth.ts`), so a calling agent's own run always matched the old
 * unconditional predicate and no agent could ever hand off the task it was
 * running. The incoming-assignee exemption covers correcting ownership to
 * whichever agent is already doing the work. Neither can orphan anything: in both
 * cases the run and the new owner are the same agent.
 *
 * This is deliberately NOT the run-concurrency check. "At most one active run per
 * task" is `isTaskBusyInDb` (`services/run-concurrency.ts`); reusing this helper
 * for that is how `start_team_setup` came to hold a reassignment guard.
 */
export async function assertNoBlockingRun(
	db: Db,
	taskId: string,
	actor: ReassignActor,
): Promise<BlockingRunCheck> {
	// Three load-bearing details in the query below.
	//
	// `IS DISTINCT FROM`, never `<>`: an admin caller passes NULL for both
	// exemptions, and `member_id <> NULL` evaluates to NULL, which filters the row
	// out and hands every admin reassignment a blanket exemption.
	//
	// The `::uuid` casts: PGlite infers `text` from a NULL parameter and then
	// errors comparing it against a uuid column.
	//
	// The ORDER BY: name the live run rather than a queued one when both exist.
	const r = await db.query<BlockingRun>(
		`SELECT hr.status::text AS status,
		        ma.slug AS slug,
		        ${agentDisplayNameSql('ma', 'm')} AS "displayName"
		   FROM heartbeat_runs hr
		   JOIN members m ON m.id = hr.member_id
		   LEFT JOIN member_agents ma ON ma.id = hr.member_id
		  WHERE hr.task_id = $1
		    AND hr.status IN ($2::heartbeat_run_status, $3::heartbeat_run_status)
		    AND hr.member_id IS DISTINCT FROM $4::uuid
		    AND hr.member_id IS DISTINCT FROM $5::uuid
		  ORDER BY CASE WHEN hr.status = $2::heartbeat_run_status THEN 0 ELSE 1 END,
		           hr.created_at DESC
		  LIMIT 1`,
		[
			taskId,
			HeartbeatRunStatus.Running,
			HeartbeatRunStatus.Queued,
			actor.callerMemberId,
			actor.incomingAssigneeId,
		],
	);
	const blocker = r.rows[0];
	if (blocker) return { ok: false, message: reassignBlockedByRunError(blocker) };
	return { ok: true };
}
