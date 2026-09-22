import { expect, test } from 'vitest';
import { manualDispatchNoticeKey } from '../src/lib/manual-dispatch';

test('a started run needs no notice', () => {
	expect(manualDispatchNoticeKey({ dispatched: true })).toBeNull();
});

test('a queued run names the wait it is in', () => {
	expect(manualDispatchNoticeKey({ queued: true, reason: 'task_busy' })).toBe(
		'tasks.dispatch.queued.taskBusy',
	);
	expect(manualDispatchNoticeKey({ queued: true, reason: 'unknown' })).toBe(
		'tasks.dispatch.queued.fallback',
	);
});

test('a refused run names the hold that refused it', () => {
	expect(manualDispatchNoticeKey({ held: true, reason: 'held' })).toBe('tasks.dispatch.held.task');
	expect(manualDispatchNoticeKey({ held: true, reason: 'over_budget' })).toBe(
		'tasks.dispatch.held.overBudget',
	);
});
