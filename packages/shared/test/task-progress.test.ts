import { describe, expect, it } from 'vitest';
import { isLastRunFailed } from '../src/task-progress';

describe('isLastRunFailed', () => {
	it('flags a failed last run only when no run is active', () => {
		expect(isLastRunFailed(false, 'failed')).toBe(true);
		expect(isLastRunFailed(false, 'timed_out')).toBe(true);
		expect(isLastRunFailed(true, 'failed')).toBe(false);
		expect(isLastRunFailed(false, 'succeeded')).toBe(false);
		expect(isLastRunFailed(false, null)).toBe(false);
	});
});
