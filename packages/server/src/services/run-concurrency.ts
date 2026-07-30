import { ContainerStatus, HeartbeatRunStatus } from '@hezo/shared';
import type { Db } from '../db/database';
import { getMaxActiveContainers } from '../lib/system-meta';

/**
 * DB-backed concurrency checks — the single source of truth for the two run
 * rules: at most one active (queued/running) agent run per task, and at most
 * `max_active_containers` (system_meta; default computed from host memory)
 * simultaneously RUNNING project containers across the instance. The container
 * cap is the memory guarantee: every container is memory-capped, so total
 * demand never exceeds `N × cap` no matter how many runs share a container.
 * Shared by the scheduler (`JobManager`, which layers its in-memory dispatch
 * guards on top) and the stateless run-now route.
 *
 * `lib/active-run.ts` and the `has_active_run` flag in `routes/tasks.ts` run
 * similar task-scoped checks for assignee-lock / badge purposes; they have
 * different return shapes and are intentionally left untouched.
 */

export async function isTaskBusyInDb(db: Db, taskId: string): Promise<boolean> {
	const active = await db.query(
		`SELECT 1 FROM heartbeat_runs
		 WHERE task_id = $1
		   AND status IN ($2::heartbeat_run_status, $3::heartbeat_run_status)
		 LIMIT 1`,
		[taskId, HeartbeatRunStatus.Queued, HeartbeatRunStatus.Running],
	);
	return active.rows.length > 0;
}

export interface ActiveContainers {
	/** Configured (or host-memory-computed) ceiling on running containers. */
	limit: number;
	/** Project ids whose container currently reads Running in the DB. */
	runningProjectIds: Set<string>;
}

/**
 * Read the instance-wide container ceiling alongside the set of projects with
 * a running container. Returning the id set (not just a count) lets callers
 * both dedupe their in-memory pending-start guards against it and pass a run
 * whose target container is already up. The projects table is tiny, so this is
 * a cheap scan.
 */
export async function getActiveContainers(db: Db): Promise<ActiveContainers> {
	const [limit, rows] = await Promise.all([
		getMaxActiveContainers(db),
		db.query<{ id: string }>(
			`SELECT id FROM projects WHERE container_status = $1::container_status`,
			[ContainerStatus.Running],
		),
	]);
	return { limit, runningProjectIds: new Set(rows.rows.map((r) => r.id)) };
}

/**
 * Stateless container-capacity gate (route-side mirror of the scheduler's
 * in-memory-guarded check): would running in `projectId` need a container
 * start that exceeds the cap? A project whose container is already running is
 * never blocked — its run consumes no new container slot.
 */
export async function isContainerCapacityBlockedInDb(db: Db, projectId: string): Promise<boolean> {
	const { limit, runningProjectIds } = await getActiveContainers(db);
	if (runningProjectIds.has(projectId)) return false;
	return runningProjectIds.size >= limit;
}

/**
 * Active (queued/running) runs inside one project. Not a capacity input — the
 * cap is instance-wide — but the repo routes gate destructive git operations
 * (reset, re-clone) on the project being quiet, and the idle-stop recheck uses
 * the same figure.
 */
export async function countActiveRunsInProject(db: Db, projectId: string): Promise<number> {
	const row = await db.query<{ active: number }>(
		`SELECT count(*)::int AS active FROM heartbeat_runs r
		 JOIN tasks t ON t.id = r.task_id
		 WHERE t.project_id = $1
		   AND r.status IN ($2::heartbeat_run_status, $3::heartbeat_run_status)`,
		[projectId, HeartbeatRunStatus.Queued, HeartbeatRunStatus.Running],
	);
	return row.rows[0]?.active ?? 0;
}

/**
 * Member ids with an active (queued/running) run anywhere in the project — the
 * set whose per-agent dispatch slot is taken. The stateless run-now route uses
 * this to mirror `JobManager.isAgentBusyInProject` minus its in-memory guard.
 */
export async function getBusyAgentIdsInProject(db: Db, projectId: string): Promise<Set<string>> {
	const res = await db.query<{ member_id: string }>(
		`SELECT DISTINCT hr.member_id FROM heartbeat_runs hr
		 JOIN tasks t ON t.id = hr.task_id
		 WHERE t.project_id = $1
		   AND hr.status IN ($2::heartbeat_run_status, $3::heartbeat_run_status)`,
		[projectId, HeartbeatRunStatus.Queued, HeartbeatRunStatus.Running],
	);
	return new Set(res.rows.map((r) => r.member_id));
}
