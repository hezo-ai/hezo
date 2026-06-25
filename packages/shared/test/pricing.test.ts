import { describe, expect, it } from 'vitest';
import { costCentsFromRate } from '../src/pricing';

describe('costCentsFromRate', () => {
	it('sums each token bucket at its own rate and rounds to cents', () => {
		const cents = costCentsFromRate(
			{
				inputPerToken: 0.001,
				outputPerToken: 0.002,
				cacheReadPerToken: 0.0001,
				cacheCreationPerToken: 0.005,
			},
			{ inputTokens: 1000, cacheReadTokens: 2000, cacheCreationTokens: 100, outputTokens: 500 },
		);
		// 1 + 0.2 + 0.5 + 1 = 2.7 dollars
		expect(cents).toBe(270);
	});

	it('falls back to the input rate when cache rates are absent or null', () => {
		const cents = costCentsFromRate(
			{
				inputPerToken: 0.001,
				outputPerToken: 0.002,
				cacheReadPerToken: null,
				cacheCreationPerToken: null,
			},
			{ inputTokens: 0, cacheReadTokens: 1000, cacheCreationTokens: 1000, outputTokens: 0 },
		);
		// (1000 + 1000) * 0.001 = 2 dollars
		expect(cents).toBe(200);
	});

	it('treats undefined or negative bucket counts as zero', () => {
		const cents = costCentsFromRate(
			{ inputPerToken: 0.001, outputPerToken: 0.002 },
			{ inputTokens: -5, outputTokens: 100 },
		);
		expect(cents).toBe(20);
	});
});
