import type { PGlite } from '@electric-sql/pglite';
import { AgentRuntimeStatus, HeartbeatRunStatus, wsRoom } from '@hezo/shared';
import { broadcastRowChange } from '../lib/broadcast';
import type { WebSocketManager } from './ws';

/**
 * Flip an agent to idle only when no other heartbeat run is queued or running
 * for it. An agent can have parallel runs across projects, so any single
 * completion path that unconditionally sets idle will lie about state while
 * other runs are still in flight.
 *
 * Guarded on `runtime_status = active` so a `paused` row (budget hit) is not
 * cleared. Broadcasts `member_agents` UPDATE only on a real transition.
 *
 * Returns true if the agent transitioned to idle, false otherwise.
 */
export async function setAgentIdleIfNoActiveRuns(
	db: PGlite,
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

	const reset = await db.query<{ id: string }>(
		`UPDATE member_agents
		 SET runtime_status = $1::agent_runtime_status, last_heartbeat_at = now()
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
