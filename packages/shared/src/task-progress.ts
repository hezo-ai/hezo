import { HeartbeatRunStatus, TERMINAL_TASK_STATUSES } from './types/common.js';

export const TEAM_COHERENCE_REVIEW_LABEL = 'team-coherence-review';

export const ProjectTaskListPhaseBanner = {
	Onboarding: 'onboarding',
} as const;
export type ProjectTaskListPhaseBanner =
	(typeof ProjectTaskListPhaseBanner)[keyof typeof ProjectTaskListPhaseBanner];

function isOpenTaskStatus(status: string): boolean {
	return !(TERMINAL_TASK_STATUSES as readonly string[]).includes(status);
}

/** Banner shown above the project task list before execution tracking begins. */
export function deriveProjectTaskListPhaseBanner(input: {
	coherenceReviewStatus: string | null;
}): ProjectTaskListPhaseBanner | null {
	if (input.coherenceReviewStatus !== null && isOpenTaskStatus(input.coherenceReviewStatus)) {
		return ProjectTaskListPhaseBanner.Onboarding;
	}
	return null;
}

export function isLastRunFailed(hasActiveRun: boolean, lastRunStatus: string | null): boolean {
	return (
		!hasActiveRun &&
		(lastRunStatus === HeartbeatRunStatus.Failed || lastRunStatus === HeartbeatRunStatus.TimedOut)
	);
}
