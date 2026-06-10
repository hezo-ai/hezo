import { TaskStatus, TERMINAL_TASK_STATUSES } from './types/common.js';

export type TaskProgressBucket = 'complete' | 'in_progress' | 'not_done';

export function taskProgressBucket(status: string): TaskProgressBucket {
	if ((TERMINAL_TASK_STATUSES as readonly string[]).includes(status)) {
		return 'complete';
	}
	if (status === TaskStatus.InProgress || status === TaskStatus.Review) {
		return 'in_progress';
	}
	return 'not_done';
}

export interface TaskProgressScopeInput {
	id: string;
	parent_task_id: string | null;
	labels: string[];
}

export function hasPlanningLabel(labels: string[]): boolean {
	return labels.includes('planning');
}

/** Execution-scope tasks exclude the planning epic and its direct sub-tasks. */
export function isExecutionScopeTask(
	task: TaskProgressScopeInput,
	planningTaskId: string | null,
): boolean {
	if (planningTaskId) {
		if (task.id === planningTaskId) return false;
		if (task.parent_task_id === planningTaskId) return false;
	}
	return !hasPlanningLabel(task.labels);
}

/** Planning-scope tasks are the planning epic and its direct sub-tasks. */
export function isPlanningScopeTask(
	task: TaskProgressScopeInput,
	planningTaskId: string | null,
): boolean {
	if (!planningTaskId) return false;
	if (task.id === planningTaskId) return true;
	return task.parent_task_id === planningTaskId;
}

export type ProjectStatusScope = 'execution' | 'planning';

/** Planning phase ends when the Captain's planning epic is Coach-closed. */
export function isPlanningPhaseComplete(planningTaskStatus: string | null): boolean {
	return planningTaskStatus === TaskStatus.Closed;
}

export const ProjectStatus = {
	Completed: 'completed',
	Error: 'error',
	Working: 'working',
	Idle: 'idle',
} as const;
export type ProjectStatus = (typeof ProjectStatus)[keyof typeof ProjectStatus];

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
	[ProjectStatus.Completed]: 'Completed',
	[ProjectStatus.Error]: 'Error',
	[ProjectStatus.Working]: 'Working',
	[ProjectStatus.Idle]: 'Idle',
};

export function formatProjectStatus(status: ProjectStatus): string {
	return PROJECT_STATUS_LABELS[status];
}

export const TEAM_COHERENCE_REVIEW_LABEL = 'team-coherence-review';

export const ProjectTaskListPhaseBanner = {
	Onboarding: 'onboarding',
	Planning: 'planning',
} as const;
export type ProjectTaskListPhaseBanner =
	(typeof ProjectTaskListPhaseBanner)[keyof typeof ProjectTaskListPhaseBanner];

function isOpenTaskStatus(status: string): boolean {
	return !(TERMINAL_TASK_STATUSES as readonly string[]).includes(status);
}

function isActivePlanningStatus(status: string): boolean {
	return status === TaskStatus.InProgress || status === TaskStatus.Review;
}

/** Banner shown above the project task list before execution tracking begins. */
export function deriveProjectTaskListPhaseBanner(input: {
	coherenceReviewStatus: string | null;
	planningTaskStatus: string | null;
}): ProjectTaskListPhaseBanner | null {
	if (input.coherenceReviewStatus !== null && isOpenTaskStatus(input.coherenceReviewStatus)) {
		return ProjectTaskListPhaseBanner.Onboarding;
	}
	if (input.planningTaskStatus !== null && isActivePlanningStatus(input.planningTaskStatus)) {
		return ProjectTaskListPhaseBanner.Planning;
	}
	return null;
}

export interface TaskProgressSummary {
	/** True when the draft execution plan ticket has reached `closed`. */
	planning_complete: boolean;
	total: number;
	complete: number;
	in_progress: number;
	not_done: number;
	percent_complete: number;
	by_status: Record<string, number>;
	/** Null before planning is complete (execution) or during the planning-phase banner. */
	project_status: ProjectStatus | null;
	project_name: string;
	phase_banner: ProjectTaskListPhaseBanner | null;
}

export interface TaskProgressRow {
	id: string;
	status: string;
	parent_task_id: string | null;
	labels: string[];
}

export interface TaskProgressStatusRow extends TaskProgressRow {
	has_active_run: boolean;
	last_run_status: string | null;
}

export function isLastRunFailed(hasActiveRun: boolean, lastRunStatus: string | null): boolean {
	return !hasActiveRun && (lastRunStatus === 'failed' || lastRunStatus === 'timed_out');
}

/**
 * Derive the headline project status for a task scope.
 * Precedence: Completed → Working → Error → Idle.
 */
export function deriveProjectStatus(
	tasks: TaskProgressStatusRow[],
	planningTaskId: string | null,
	scope: ProjectStatusScope,
): ProjectStatus | null {
	const scoped = tasks.filter((t) =>
		scope === 'execution'
			? isExecutionScopeTask(t, planningTaskId)
			: isPlanningScopeTask(t, planningTaskId),
	);
	if (scoped.length === 0) return null;

	const terminal = TERMINAL_TASK_STATUSES as readonly string[];
	if (scoped.every((t) => terminal.includes(t.status))) {
		return ProjectStatus.Completed;
	}

	if (scoped.some((t) => t.has_active_run)) {
		return ProjectStatus.Working;
	}

	const inProgress = scoped.filter((t) => t.status === TaskStatus.InProgress);
	if (
		inProgress.length > 0 &&
		inProgress.every((t) => isLastRunFailed(t.has_active_run, t.last_run_status))
	) {
		return ProjectStatus.Error;
	}

	return ProjectStatus.Idle;
}

export function buildTaskProgressSummary(input: {
	planningTaskId: string | null;
	planningTaskStatus: string | null;
	coherenceReviewStatus: string | null;
	projectName: string;
	tasks: TaskProgressStatusRow[];
}): TaskProgressSummary {
	const planningComplete = isPlanningPhaseComplete(input.planningTaskStatus);

	const by_status: Record<string, number> = {};
	let complete = 0;
	let in_progress = 0;
	let not_done = 0;
	let total = 0;

	if (planningComplete) {
		for (const task of input.tasks) {
			if (!isExecutionScopeTask(task, input.planningTaskId)) continue;
			total++;
			by_status[task.status] = (by_status[task.status] ?? 0) + 1;
			const bucket = taskProgressBucket(task.status);
			if (bucket === 'complete') complete++;
			else if (bucket === 'in_progress') in_progress++;
			else not_done++;
		}
	}

	const percent_complete = total > 0 ? Math.round((complete / total) * 100) : 0;

	const phase_banner = deriveProjectTaskListPhaseBanner({
		coherenceReviewStatus: input.coherenceReviewStatus,
		planningTaskStatus: input.planningTaskStatus,
	});

	const project_status = planningComplete
		? deriveProjectStatus(input.tasks, input.planningTaskId, 'execution')
		: phase_banner === ProjectTaskListPhaseBanner.Planning
			? deriveProjectStatus(input.tasks, input.planningTaskId, 'planning')
			: null;

	return {
		planning_complete: planningComplete,
		total,
		complete,
		in_progress,
		not_done,
		percent_complete,
		by_status,
		project_status,
		project_name: input.projectName,
		phase_banner,
	};
}
