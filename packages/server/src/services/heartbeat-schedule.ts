import {
	AgentAdminStatus,
	BUDGET_PAUSE_STATUSES,
	HEARTBEAT_INTERVAL_FLOOR_MIN_DEFAULT,
	TERMINAL_TASK_STATUSES,
} from '@hezo/shared';
import { runtimeConfig } from '../config/runtime';

/**
 * Lower bound on how often a heartbeat can fire, regardless of an agent's
 * configured `heartbeat_interval_min`. Defends against misconfigured low/zero
 * intervals producing a tight scheduler loop on the same agent.
 *
 * Single source of truth for both the scheduler (`JobManager`) and the agents
 * API's computed `next_heartbeat_at` (see `NEXT_HEARTBEAT_AT_SQL`), so the
 * displayed countdown matches the cadence the scheduler actually enforces.
 * Coerced NaN-safe because it is interpolated into SQL below.
 */
export function heartbeatIntervalFloorMin(): number {
	const configured = runtimeConfig().jobs.heartbeatFloorMin;
	return Number.isFinite(configured) ? configured : HEARTBEAT_INTERVAL_FLOOR_MIN_DEFAULT;
}

// Fixed enum values from `@hezo/shared` — safe to interpolate as a Postgres
// array literal.
const BUDGET_PAUSE_ARRAY_PG = `{${BUDGET_PAUSE_STATUSES.join(',')}}`;
const TERMINAL_TASK_STATUSES_PG = `{${TERMINAL_TASK_STATUSES.join(',')}}`;

/**
 * SQL expression yielding an agent's next scheduled heartbeat as a TIMESTAMPTZ,
 * computed from a joined `member_agents ma` row. Mirrors the eligibility and
 * cadence in `JobManager.processScheduledHeartbeats`:
 *
 * - `NULL` when the agent is off the schedule — admin-disabled, or reactively
 *   paused for budget — so the UI shows no countdown for an agent that won't tick.
 * - `now()` when it has never run a heartbeat (`last_heartbeat_at IS NULL`): the
 *   scheduler treats it as immediately due.
 * - otherwise `last_heartbeat_at + max(interval, floor)`.
 *
 * Only references `ma.*`, so it composes into any projection that joins
 * `member_agents AS ma`. The interpolated values are a coerced number and fixed
 * enum constants (no user input).
 */
export function nextHeartbeatAtSql(): string {
	return `CASE
	WHEN ma.admin_status <> '${AgentAdminStatus.Enabled}'::agent_admin_status THEN NULL
	WHEN ma.runtime_status = ANY('${BUDGET_PAUSE_ARRAY_PG}'::agent_runtime_status[]) THEN NULL
	WHEN ma.last_heartbeat_at IS NULL THEN now()
	ELSE ma.last_heartbeat_at + (GREATEST(ma.heartbeat_interval_min, ${heartbeatIntervalFloorMin()}) || ' minutes')::interval
END`;
}

/**
 * SQL boolean — does this agent have an actionable task *right now*? Mirrors the
 * task selection in `JobManager.activateAgent`: a non-terminal task assigned to
 * the agent whose blockers are all closed. When false, a scheduled heartbeat
 * fires but finds nothing to do (a no-op), so the UI shows a dash instead of a
 * countdown — a "next heartbeat" that will not actually run anything would only
 * mislead.
 *
 * Keyed on `ma.id` alone, so it composes into any projection joining
 * `member_agents AS ma`. Like the scheduler's own selection it carries no team
 * filter — keying on the specific agent (`assignee_id = ma.id`) keeps it correct
 * for both team-scoped agents and the cross-team instance agents (CEO/Coach).
 * Interpolates fixed enum constants only (no user input).
 */
export const HAS_ACTIONABLE_WORK_SQL = `EXISTS (
	SELECT 1 FROM tasks i
	WHERE i.assignee_id = ma.id
	  AND i.status <> ALL('${TERMINAL_TASK_STATUSES_PG}'::task_status[])
	  AND NOT EXISTS (
	    SELECT 1 FROM task_dependencies d
	    JOIN tasks b ON b.id = d.blocked_by_task_id
	    WHERE d.task_id = i.id
	      AND b.status <> ALL('${TERMINAL_TASK_STATUSES_PG}'::task_status[])
	  )
)`;
