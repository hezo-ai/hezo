import { costCentsFromRate, type ModelRate } from '@hezo/shared';
import { describe, expect, it } from 'vitest';

describe('costCentsFromRate', () => {
	it('prices the four token buckets at their own rates', () => {
		const rate: ModelRate = {
			inputPerToken: 0.000003,
			outputPerToken: 0.000015,
			cacheReadPerToken: 3e-7,
			cacheCreationPerToken: 0.00000375,
		};
		const cents = costCentsFromRate(rate, {
			inputTokens: 1_000_000,
			cacheReadTokens: 1_000_000,
			cacheCreationTokens: 100_000,
			outputTokens: 200_000,
		});
		// 1e6*3e-6 + 1e6*3e-7 + 1e5*3.75e-6 + 2e5*1.5e-5
		//   = 3 + 0.3 + 0.375 + 3 = 6.675 → 667.5 → 668 cents
		expect(cents).toBe(668);
	});

	it('charges cache reads at the discounted rate, not the base input rate', () => {
		// A cache-read-dominated agentic run — the case that breaks if buckets are
		// collapsed and charged the base input rate.
		const rate: ModelRate = {
			inputPerToken: 0.000003,
			outputPerToken: 0.000015,
			cacheReadPerToken: 3e-7,
		};
		const tokens = { inputTokens: 50_000, cacheReadTokens: 950_000, outputTokens: 10_000 };
		// 5e4*3e-6 + 9.5e5*3e-7 + 1e4*1.5e-5 = 0.15 + 0.285 + 0.15 = 0.585 → 59 cents
		const correct = costCentsFromRate(rate, tokens);
		expect(correct).toBe(59);

		// Collapsing cache reads into the base input rate (the ~10x overstatement):
		// (5e4+9.5e5)*3e-6 + 0.15 = 3.0 + 0.15 = 3.15 → 315 cents
		const collapsed = costCentsFromRate({ ...rate, cacheReadPerToken: rate.inputPerToken }, tokens);
		expect(collapsed).toBe(315);
		expect(collapsed).toBeGreaterThan(correct * 5);
	});

	it('falls back to the input rate when a cache rate is absent', () => {
		const rate: ModelRate = { inputPerToken: 0.000001, outputPerToken: 0.000002 };
		// 1e6 cache reads with no cache rate → priced at inputPerToken = 1.0 → 100 cents
		expect(
			costCentsFromRate(rate, { inputTokens: 0, cacheReadTokens: 1_000_000, outputTokens: 0 }),
		).toBe(100);
	});

	it('ignores negative or missing buckets', () => {
		const rate: ModelRate = { inputPerToken: 0.00001, outputPerToken: 0.00001 };
		expect(costCentsFromRate(rate, { inputTokens: -5, outputTokens: 0 })).toBe(0);
	});
});
