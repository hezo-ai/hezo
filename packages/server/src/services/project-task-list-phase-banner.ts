import type { PGlite } from '@electric-sql/pglite';
import {
	deriveProjectTaskListPhaseBanner,
	type ProjectTaskListPhaseBanner,
	TEAM_COHERENCE_REVIEW_LABEL,
	TERMINAL_TASK_STATUSES,
} from '@hezo/shared';

export interface ProjectTaskListPhaseBannerState {
	phase_banner: ProjectTaskListPhaseBanner | null;
}

/**
 * The banner shown above a project's task list before execution tracking begins.
 * Onboarding fires while the CEO's `team-coherence-review` task is still open.
 */
export async function getProjectTaskListPhaseBanner(
	db: PGlite,
	projectId: string,
): Promise<ProjectTaskListPhaseBannerState> {
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

	return { phase_banner: deriveProjectTaskListPhaseBanner({ coherenceReviewStatus }) };
}
