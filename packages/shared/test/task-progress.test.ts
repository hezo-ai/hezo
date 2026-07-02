import { describe, expect, it } from 'vitest';
import { deriveProjectTaskListPhaseBanner, isLastRunFailed } from '../src/task-progress';
import { TaskStatus } from '../src/types/common';

describe('isLastRunFailed', () => {
	it('flags a failed last run only when no run is active', () => {
		expect(isLastRunFailed(false, 'failed')).toBe(true);
		expect(isLastRunFailed(false, 'timed_out')).toBe(true);
		expect(isLastRunFailed(true, 'failed')).toBe(false);
		expect(isLastRunFailed(false, 'succeeded')).toBe(false);
		expect(isLastRunFailed(false, null)).toBe(false);
	});
});

describe('deriveProjectTaskListPhaseBanner', () => {
	it('shows the onboarding banner only while a coherence review is open', () => {
		expect(deriveProjectTaskListPhaseBanner({ coherenceReviewStatus: TaskStatus.InProgress })).toBe(
			'onboarding',
		);
		expect(deriveProjectTaskListPhaseBanner({ coherenceReviewStatus: TaskStatus.Done })).toBeNull();
		expect(deriveProjectTaskListPhaseBanner({ coherenceReviewStatus: null })).toBeNull();
	});
});
