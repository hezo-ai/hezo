import type { PGlite } from '@electric-sql/pglite';
import { HeartbeatRunStatus } from '@hezo/shared';

/**
 * DB-backed concurrency checks — the single source of truth for the two run
 * rules: at most one active (queued/running) agent run per task, and at most
 * `projects.max_concurrent_runs` per project. Shared by the scheduler
 * (`JobManager`, which layers its in-memory dispatch guards on top) and the
 * stateless run-now route.
 *
 * `lib/active-run.ts` and the `has_active_run` flag in `routes/tasks.ts` run
 * similar task-scoped checks for assignee-lock / badge purposes; they have
 * different return shapes and are intentionally left untouched.
 */

export async function isTaskBusyInDb(db: PGlite, taskId: string): Promise<boolean> {
	const active = await db.query(
		`SELECT 1 FROM heartbeat_runs
		 WHERE task_id = $1
		   AND status IN ($2::heartbeat_run_status, $3::heartbeat_run_status)
		 LIMIT 1`,
		[taskId, HeartbeatRunStatus.Queued, HeartbeatRunStatus.Running],
	);
	return active.rows.length > 0;
}

export interface ProjectConcurrency {
	/** Configured ceiling on simultaneous agent runs for the project. */
	limit: number;
	/** Active (queued/running) runs currently counted against that ceiling. */
	active: number;
}

/**
 * Read a project's concurrency ceiling alongside its current active-run count
 * in a single query. The scheduler reconciles `active` against its in-memory
 * dispatch refcount (taking the larger of the two) before comparing to `limit`.
 */
export async function getProjectConcurrency(
	db: PGlite,
	projectId: string,
): Promise<ProjectConcurrency> {
	const row = await db.query<{ limit: number; active: number }>(
		`SELECT p.max_concurrent_runs AS limit,
		        (SELECT count(*)::int FROM heartbeat_runs r
		           JOIN tasks t ON t.id = r.task_id
		          WHERE t.project_id = p.id
		            AND r.status IN ($2::heartbeat_run_status, $3::heartbeat_run_status)) AS active
		 FROM projects p
		 WHERE p.id = $1`,
		[projectId, HeartbeatRunStatus.Queued, HeartbeatRunStatus.Running],
	);
	const r = row.rows[0];
	return { limit: r?.limit ?? 1, active: r?.active ?? 0 };
}

export async function isProjectAtCapacityInDb(db: PGlite, projectId: string): Promise<boolean> {
	const { limit, active } = await getProjectConcurrency(db, projectId);
	return active >= limit;
}

/**
 * Member ids with an active (queued/running) run anywhere in the project — the
 * set whose per-agent dispatch slot is taken. The stateless run-now route uses
 * this to mirror `JobManager.isAgentBusyInProject` minus its in-memory guard.
 */
export async function getBusyAgentIdsInProject(
	db: PGlite,
	projectId: string,
): Promise<Set<string>> {
	const res = await db.query<{ member_id: string }>(
		`SELECT DISTINCT hr.member_id FROM heartbeat_runs hr
		 JOIN tasks t ON t.id = hr.task_id
		 WHERE t.project_id = $1
		   AND hr.status IN ($2::heartbeat_run_status, $3::heartbeat_run_status)`,
		[projectId, HeartbeatRunStatus.Queued, HeartbeatRunStatus.Running],
	);
	return new Set(res.rows.map((r) => r.member_id));
}
