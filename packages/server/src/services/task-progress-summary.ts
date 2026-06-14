import type { PGlite } from '@electric-sql/pglite';
import {
	buildTaskProgressSummary,
	type TaskProgressSummary,
	TEAM_COHERENCE_REVIEW_LABEL,
	TERMINAL_TASK_STATUSES,
} from '@hezo/shared';

export async function getTaskProgressSummary(
	db: PGlite,
	projectId: string,
): Promise<TaskProgressSummary> {
	const project = await db.query<{ name: string }>('SELECT name FROM projects WHERE id = $1', [
		projectId,
	]);
	const projectName = project.rows[0]?.name ?? '';

	const coherencePlaceholders = TERMINAL_TASK_STATUSES.map((_, i) => `$${i + 3}::task_status`).join(
		', ',
	);
	const coherence = await db.query<{ status: string }>(
		`SELECT status::text FROM tasks
		 WHERE project_id = $1
		   AND labels @> $2::jsonb
		   AND status NOT IN (${coherencePlaceholders})
		 ORDER BY number ASC
		 LIMIT 1`,
		[projectId, JSON.stringify([TEAM_COHERENCE_REVIEW_LABEL]), ...TERMINAL_TASK_STATUSES],
	);
	const coherenceReviewStatus = coherence.rows[0]?.status ?? null;

	const planning = await db.query<{ id: string; status: string }>(
		`SELECT id, status::text FROM tasks
		 WHERE project_id = $1 AND labels @> '["planning"]'::jsonb
		 LIMIT 1`,
		[projectId],
	);
	const planningTaskId = planning.rows[0]?.id ?? null;
	const planningTaskStatus = planning.rows[0]?.status ?? null;

	const tasks = await db.query<{
		id: string;
		status: string;
		parent_task_id: string | null;
		labels: string[];
		has_active_run: boolean;
		last_run_status: string | null;
	}>(
		`SELECT t.id, t.status::text, t.parent_task_id, t.labels,
		        EXISTS (
		          SELECT 1 FROM heartbeat_runs hr
		          WHERE hr.task_id = t.id AND hr.status IN ('running', 'queued')
		        ) AS has_active_run,
		        (
		          SELECT hr.status::text
		          FROM heartbeat_runs hr
		          WHERE hr.task_id = t.id AND hr.status NOT IN ('queued', 'running')
		          ORDER BY hr.finished_at DESC NULLS LAST, hr.started_at DESC
		          LIMIT 1
		        ) AS last_run_status
		 FROM tasks t
		 WHERE t.project_id = $1`,
		[projectId],
	);

	return buildTaskProgressSummary({
		planningTaskId,
		planningTaskStatus,
		coherenceReviewStatus,
		projectName,
		tasks: tasks.rows.map((row) => ({
			id: row.id,
			status: row.status,
			parent_task_id: row.parent_task_id,
			labels: Array.isArray(row.labels) ? row.labels : [],
			has_active_run: row.has_active_run,
			last_run_status: row.last_run_status,
		})),
	});
}
