import { describe, expect, it } from 'vitest';
import {
	buildTaskProgressSummary,
	deriveProjectStatus,
	deriveProjectTaskListPhaseBanner,
	formatProjectStatus,
	hasPlanningLabel,
	isExecutionScopeTask,
	isLastRunFailed,
	isPlanningPhaseComplete,
	ProjectStatus,
	type TaskProgressStatusRow,
	taskProgressBucket,
} from '../src/task-progress';
import { TaskStatus } from '../src/types/common';

const row = (over: Partial<TaskProgressStatusRow> & { id: string }): TaskProgressStatusRow => ({
	status: TaskStatus.Backlog,
	parent_task_id: null,
	labels: [],
	has_active_run: false,
	last_run_status: null,
	...over,
});

describe('taskProgressBucket', () => {
	it('buckets terminal, in-progress, and not-done statuses', () => {
		expect(taskProgressBucket(TaskStatus.Done)).toBe('complete');
		expect(taskProgressBucket(TaskStatus.Cancelled)).toBe('complete');
		expect(taskProgressBucket(TaskStatus.InProgress)).toBe('in_progress');
		expect(taskProgressBucket(TaskStatus.Review)).toBe('in_progress');
		expect(taskProgressBucket(TaskStatus.Backlog)).toBe('not_done');
		expect(taskProgressBucket(TaskStatus.Blocked)).toBe('not_done');
	});
});

describe('scope helpers', () => {
	it('detects the planning label', () => {
		expect(hasPlanningLabel(['planning'])).toBe(true);
		expect(hasPlanningLabel(['other'])).toBe(false);
	});

	it('excludes the planning epic, its direct children, and planning-labelled tasks', () => {
		expect(isExecutionScopeTask(row({ id: 'epic' }), 'epic')).toBe(false);
		expect(isExecutionScopeTask(row({ id: 'child', parent_task_id: 'epic' }), 'epic')).toBe(false);
		expect(isExecutionScopeTask(row({ id: 'lbl', labels: ['planning'] }), 'epic')).toBe(false);
		expect(isExecutionScopeTask(row({ id: 'work' }), 'epic')).toBe(true);
		expect(isExecutionScopeTask(row({ id: 'work' }), null)).toBe(true);
	});

	it('marks planning complete only when the epic is done', () => {
		expect(isPlanningPhaseComplete(TaskStatus.Done)).toBe(true);
		expect(isPlanningPhaseComplete(TaskStatus.InProgress)).toBe(false);
		expect(isPlanningPhaseComplete(null)).toBe(false);
	});

	it('flags a failed last run only when no run is active', () => {
		expect(isLastRunFailed(false, 'failed')).toBe(true);
		expect(isLastRunFailed(false, 'timed_out')).toBe(true);
		expect(isLastRunFailed(true, 'failed')).toBe(false);
		expect(isLastRunFailed(false, 'succeeded')).toBe(false);
	});
});

describe('formatProjectStatus / phase banner', () => {
	it('formats project status labels', () => {
		expect(formatProjectStatus(ProjectStatus.Working)).toBe('Working');
		expect(formatProjectStatus(ProjectStatus.Idle)).toBe('Idle');
	});

	it('shows the onboarding banner only while a coherence review is open', () => {
		expect(deriveProjectTaskListPhaseBanner({ coherenceReviewStatus: TaskStatus.InProgress })).toBe(
			'onboarding',
		);
		expect(deriveProjectTaskListPhaseBanner({ coherenceReviewStatus: TaskStatus.Done })).toBeNull();
		expect(deriveProjectTaskListPhaseBanner({ coherenceReviewStatus: null })).toBeNull();
	});
});

describe('deriveProjectStatus', () => {
	it('returns null when there are no execution-scope tasks', () => {
		expect(deriveProjectStatus([], null)).toBeNull();
		expect(deriveProjectStatus([row({ id: 'epic' })], 'epic')).toBeNull();
	});

	it('is Completed when every scoped task is terminal', () => {
		const tasks = [
			row({ id: 'a', status: TaskStatus.Done }),
			row({ id: 'b', status: TaskStatus.Cancelled }),
		];
		expect(deriveProjectStatus(tasks, null)).toBe(ProjectStatus.Completed);
	});

	it('is Working when any scoped task has an active run', () => {
		const tasks = [row({ id: 'a', status: TaskStatus.InProgress, has_active_run: true })];
		expect(deriveProjectStatus(tasks, null)).toBe(ProjectStatus.Working);
	});

	it('is Error when in-progress tasks all have a failed last run', () => {
		const tasks = [row({ id: 'a', status: TaskStatus.InProgress, last_run_status: 'failed' })];
		expect(deriveProjectStatus(tasks, null)).toBe(ProjectStatus.Error);
	});

	it('is Idle otherwise', () => {
		expect(deriveProjectStatus([row({ id: 'a', status: TaskStatus.Backlog })], null)).toBe(
			ProjectStatus.Idle,
		);
	});
});

describe('buildTaskProgressSummary', () => {
	it('reports zeroed progress until planning is complete', () => {
		const s = buildTaskProgressSummary({
			planningTaskId: 'epic',
			planningTaskStatus: TaskStatus.InProgress,
			coherenceReviewStatus: null,
			projectName: 'Demo',
			tasks: [row({ id: 'a', status: TaskStatus.Done })],
		});
		expect(s.planning_complete).toBe(false);
		expect(s.total).toBe(0);
		expect(s.percent_complete).toBe(0);
		expect(s.project_status).toBeNull();
		expect(s.project_name).toBe('Demo');
	});

	it('counts execution-scope tasks once planning is done', () => {
		const s = buildTaskProgressSummary({
			planningTaskId: 'epic',
			planningTaskStatus: TaskStatus.Done,
			coherenceReviewStatus: null,
			projectName: 'Demo',
			tasks: [
				row({ id: 'epic', status: TaskStatus.Done }),
				row({ id: 'a', status: TaskStatus.Done }),
				row({ id: 'b', status: TaskStatus.InProgress }),
				row({ id: 'c', status: TaskStatus.Backlog }),
			],
		});
		expect(s.total).toBe(3);
		expect(s.complete).toBe(1);
		expect(s.in_progress).toBe(1);
		expect(s.not_done).toBe(1);
		expect(s.percent_complete).toBe(33);
		expect(s.by_status[TaskStatus.Done]).toBe(1);
	});
});
