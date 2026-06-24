import { AgentAdminStatus, BUDGET_PAUSE_STATUSES } from '@hezo/shared';

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
const rawFloorMin = Number(process.env.HEZO_HEARTBEAT_FLOOR_MIN ?? 60);
export const HEARTBEAT_INTERVAL_FLOOR_MIN = Number.isFinite(rawFloorMin) ? rawFloorMin : 60;

// Fixed enum values from `@hezo/shared` — safe to interpolate as a Postgres
// array literal.
const BUDGET_PAUSE_ARRAY_PG = `{${BUDGET_PAUSE_STATUSES.join(',')}}`;

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
export const NEXT_HEARTBEAT_AT_SQL = `CASE
	WHEN ma.admin_status <> '${AgentAdminStatus.Enabled}'::agent_admin_status THEN NULL
	WHEN ma.runtime_status = ANY('${BUDGET_PAUSE_ARRAY_PG}'::agent_runtime_status[]) THEN NULL
	WHEN ma.last_heartbeat_at IS NULL THEN now()
	ELSE ma.last_heartbeat_at + (GREATEST(ma.heartbeat_interval_min, ${HEARTBEAT_INTERVAL_FLOOR_MIN}) || ' minutes')::interval
END`;
