import {
	AgentRuntimeStatus,
	BUDGET_PAUSE_STATUSES,
	HeartbeatRunStatus,
	wsRoom,
} from '@hezo/shared';
import type { Db } from '../db/database';
import { broadcastRowChange } from '../lib/broadcast';
import { logger } from '../logger';
import { checkOverBudget, type OverBudgetBlock } from './budget';
import { postAdminNotice } from './comment-wakeups';
import type { WebSocketManager } from './ws';

const log = logger.child('agent-runtime-status');

/** Postgres array literal of the budget-pause states, for `= ANY($n::…[])`. */
const BUDGET_PAUSE_STATUSES_PG = `{${BUDGET_PAUSE_STATUSES.join(',')}}`;

/**
 * Flip an agent to idle only when no other heartbeat run is queued or running
 * for it. An agent can have parallel runs across projects, so any single
 * completion path that unconditionally sets idle will lie about state while
 * other runs are still in flight.
 *
 * The `runtime_status` transition is guarded on `active` so a reactive
 * `out_of_*_budget` pause is not cleared by a run finishing (those clear via the
 * budget sweep). The `last_heartbeat_at` advance is unconditional
 * once we know no other runs remain — the heartbeat scheduler relies on it to
 * throttle the next wakeup, and gating it on a status that may have already
 * moved (orphan detector, container cleanup, etc.) leaves the agent eligible
 * on the very next cron tick.
 *
 * Returns true if the agent transitioned to idle, false otherwise.
 */
export async function setAgentIdleIfNoActiveRuns(
	db: Db,
	memberId: string,
	teamId: string,
	excludeRunId: string | undefined,
	wsManager: WebSocketManager | undefined,
): Promise<boolean> {
	const remaining = await db.query<{ id: string }>(
		`SELECT id FROM heartbeat_runs
		 WHERE member_id = $1
		   AND status IN ($2::heartbeat_run_status, $3::heartbeat_run_status)
		   AND ($4::uuid IS NULL OR id != $4::uuid)
		 LIMIT 1`,
		[memberId, HeartbeatRunStatus.Queued, HeartbeatRunStatus.Running, excludeRunId ?? null],
	);
	if (remaining.rows.length > 0) return false;

	await db.query('UPDATE member_agents SET last_heartbeat_at = now() WHERE id = $1', [memberId]);

	const reset = await db.query<{ id: string }>(
		`UPDATE member_agents
		 SET runtime_status = $1::agent_runtime_status
		 WHERE id = $2 AND runtime_status = $3::agent_runtime_status
		 RETURNING id`,
		[AgentRuntimeStatus.Idle, memberId, AgentRuntimeStatus.Active],
	);
	if (reset.rows.length === 0) return false;

	broadcastRowChange(wsManager, wsRoom.team(teamId), 'member_agents', 'UPDATE', {
		id: memberId,
		runtime_status: AgentRuntimeStatus.Idle,
	});
	return true;
}

/** The runtime status representing a budget block, keyed by its scope. */
export function budgetPauseStatus(block: OverBudgetBlock): AgentRuntimeStatus {
	return block.scope === 'project'
		? AgentRuntimeStatus.OutOfProjectBudget
		: AgentRuntimeStatus.OutOfAgentBudget;
}

/**
 * Reactively pause an agent for a budget trip - the single entry point shared by
 * the pre-run gate, post-run usage enforcement, and the manual usage-insert
 * route, so every window (daily/weekly/monthly) and scope (agent/project) pauses
 * identically. Sets the scoped `out_of_*_budget` status, writing only when the
 * status actually changes (so we don't churn broadcasts re-pausing an
 * already-paused agent).
 *
 * The pause is also a notice to the admin, on the task the agent was working
 * when there is one: the budget, what was used and the window, in their inbox.
 * Only the transition posts it, so a second trip into the same pause is silent.
 */
export async function pauseAgentForBudget(
	db: Db,
	memberId: string,
	teamId: string,
	block: OverBudgetBlock,
	wsManager: WebSocketManager | undefined,
	context: { taskId: string | null } = { taskId: null },
): Promise<void> {
	const status = budgetPauseStatus(block);
	const res = await db.query<{ id: string; slug: string }>(
		`UPDATE member_agents
		 SET runtime_status = $1::agent_runtime_status
		 WHERE id = $2
		   AND runtime_status IS DISTINCT FROM $1::agent_runtime_status
		 RETURNING id, slug`,
		[status, memberId],
	);
	if (res.rows.length === 0) return;
	broadcastRowChange(wsManager, wsRoom.team(teamId), 'member_agents', 'UPDATE', {
		id: memberId,
		runtime_status: status,
	});
	if (!context.taskId) return;
	const slug = res.rows[0].slug;
	const whose = block.scope === 'project' ? "the project's" : `@${slug}'s`;
	await postAdminNotice({
		db,
		teamId,
		taskId: context.taskId,
		content: {
			kind: BUDGET_PAUSED_COMMENT_KIND,
			agent_slug: slug,
			scope: block.scope,
			period: block.period,
			used_tokens: block.usedTokens,
			limit_tokens: block.limitTokens,
			text: `@${slug} is paused: ${whose} ${block.period} budget of ${block.limitTokens.toLocaleString('en-US')} tokens is used up (${block.usedTokens.toLocaleString('en-US')} used). Raise the budget to let it run again before the window resets.`,
		},
		wsManager,
	}).catch((e) => log.error(`Failed to post the budget pause notice for ${slug}:`, e));
}

/** The system comment kind that tells the admin an agent was paused by a budget. */
export const BUDGET_PAUSED_COMMENT_KIND = 'budget_paused';

/**
 * Re-evaluate a budget-paused agent against its current (rolling) spend and
 * reconcile its runtime status: lift the pause back to `idle` once every window
 * is within limit, or restamp the scope if a different window now binds (e.g.
 * the agent window rolled over but the project is still over). The inverse of
 * {@link pauseAgentForBudget}; the budget-resume sweep calls it per paused agent.
 *
 * Only ever transitions *from* a budget-pause state, so a human `paused` or an
 * in-flight `active`/run is never disturbed. Returns the new status when it
 * changed, else null.
 */
export async function reconcileBudgetPause(
	db: Db,
	memberId: string,
	teamId: string,
	projectId: string | null,
	wsManager: WebSocketManager | undefined,
): Promise<AgentRuntimeStatus | null> {
	const block = await checkOverBudget(db, memberId, projectId);
	const next = block ? budgetPauseStatus(block) : AgentRuntimeStatus.Idle;
	const res = await db.query<{ id: string }>(
		`UPDATE member_agents
		 SET runtime_status = $1::agent_runtime_status
		 WHERE id = $2
		   AND runtime_status = ANY($3::agent_runtime_status[])
		   AND runtime_status IS DISTINCT FROM $1::agent_runtime_status
		 RETURNING id`,
		[next, memberId, BUDGET_PAUSE_STATUSES_PG],
	);
	if (res.rows.length === 0) return null;
	broadcastRowChange(wsManager, wsRoom.team(teamId), 'member_agents', 'UPDATE', {
		id: memberId,
		runtime_status: next,
	});
	return next;
}
