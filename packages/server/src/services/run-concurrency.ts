import type { PGlite } from '@electric-sql/pglite';
import { HeartbeatRunStatus } from '@hezo/shared';

/**
 * DB-backed concurrency checks — the single source of truth for the two run
 * rules: at most one active (queued/running) agent run per task, and at most
 * one per project. Shared by the scheduler (`JobManager`, which layers its
 * in-memory dispatch guards on top) and the stateless run-now route.
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

export async function isProjectBusyInDb(db: PGlite, projectId: string): Promise<boolean> {
	const active = await db.query(
		`SELECT 1 FROM heartbeat_runs r
		 JOIN tasks t ON t.id = r.task_id
		 WHERE t.project_id = $1
		   AND r.status IN ($2::heartbeat_run_status, $3::heartbeat_run_status)
		 LIMIT 1`,
		[projectId, HeartbeatRunStatus.Queued, HeartbeatRunStatus.Running],
	);
	return active.rows.length > 0;
}

export async function findBusyTaskOnProject(db: PGlite, projectId: string): Promise<string | null> {
	const active = await db.query<{ task_id: string }>(
		`SELECT r.task_id FROM heartbeat_runs r
		 JOIN tasks t ON t.id = r.task_id
		 WHERE t.project_id = $1
		   AND r.status IN ($2::heartbeat_run_status, $3::heartbeat_run_status)
		 ORDER BY r.created_at ASC
		 LIMIT 1`,
		[projectId, HeartbeatRunStatus.Queued, HeartbeatRunStatus.Running],
	);
	return active.rows[0]?.task_id ?? null;
}
