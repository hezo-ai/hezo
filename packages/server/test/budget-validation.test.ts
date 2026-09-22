import {
	minMonthlyTokens,
	minWeeklyTokens,
	normalizeBudgetWindowsUp,
	validateBudgetWindows,
} from '@hezo/shared';
import { describe, expect, it } from 'vitest';

// A daily 2,000 tokens implies a weekly floor of 14,000 and a monthly floor of
// ceil(2000*365/12) = 60,834.
const DAILY = 2000;
const WEEKLY_FLOOR = 14000; // 2000 * 7
const MONTHLY_FLOOR_FROM_DAILY = 60834; // ceil(2000 * 365 / 12)
const WEEKLY = 14000;
const MONTHLY_FLOOR_FROM_WEEKLY = 60667; // ceil(14000 * 52 / 12)

describe('minWeeklyTokens', () => {
	it('is daily × 7 when daily is enabled', () => {
		expect(minWeeklyTokens(DAILY)).toBe(WEEKLY_FLOOR);
	});
	it('is 0 (no constraint) when daily is disabled', () => {
		expect(minWeeklyTokens(0)).toBe(0);
	});
});

describe('minMonthlyTokens', () => {
	it('takes the daily-implied floor (ceil of /12)', () => {
		expect(minMonthlyTokens(DAILY, 0)).toBe(MONTHLY_FLOOR_FROM_DAILY);
	});
	it('takes the weekly-implied floor when no daily', () => {
		expect(minMonthlyTokens(0, WEEKLY)).toBe(MONTHLY_FLOOR_FROM_WEEKLY);
	});
	it('takes the larger of the two when both enabled', () => {
		expect(minMonthlyTokens(DAILY, WEEKLY)).toBe(
			Math.max(MONTHLY_FLOOR_FROM_DAILY, MONTHLY_FLOOR_FROM_WEEKLY),
		);
	});
	it('is 0 when both shorter windows are disabled', () => {
		expect(minMonthlyTokens(0, 0)).toBe(0);
	});
});

describe('validateBudgetWindows', () => {
	it('accepts a coherent trio exactly at the floors', () => {
		expect(
			validateBudgetWindows({
				daily_budget_tokens: DAILY,
				weekly_budget_tokens: WEEKLY_FLOOR,
				monthly_budget_tokens: MONTHLY_FLOOR_FROM_DAILY,
			}),
		).toEqual([]);
	});

	it('rejects weekly one token under the daily-implied floor', () => {
		const v = validateBudgetWindows({
			daily_budget_tokens: DAILY,
			weekly_budget_tokens: WEEKLY_FLOOR - 1,
			monthly_budget_tokens: 0,
		});
		expect(v).toHaveLength(1);
		expect(v[0].field).toBe('weekly_budget_tokens');
		expect(v[0].minTokens).toBe(WEEKLY_FLOOR);
	});

	it('rejects monthly one token under the floor', () => {
		const v = validateBudgetWindows({
			daily_budget_tokens: DAILY,
			weekly_budget_tokens: 0,
			monthly_budget_tokens: MONTHLY_FLOOR_FROM_DAILY - 1,
		});
		expect(v).toHaveLength(1);
		expect(v[0].field).toBe('monthly_budget_tokens');
		expect(v[0].minTokens).toBe(MONTHLY_FLOOR_FROM_DAILY);
	});

	it('skips disabled (0) windows', () => {
		// weekly disabled → no weekly constraint; monthly meets the daily floor → valid.
		expect(
			validateBudgetWindows({
				daily_budget_tokens: DAILY,
				weekly_budget_tokens: 0,
				monthly_budget_tokens: MONTHLY_FLOOR_FROM_DAILY,
			}),
		).toEqual([]);
	});

	it('treats an all-disabled trio as valid', () => {
		expect(
			validateBudgetWindows({
				daily_budget_tokens: 0,
				weekly_budget_tokens: 0,
				monthly_budget_tokens: 0,
			}),
		).toEqual([]);
	});
});

describe('normalizeBudgetWindowsUp', () => {
	it('raises dependent longer windows up to their floors', () => {
		expect(
			normalizeBudgetWindowsUp({
				daily_budget_tokens: DAILY,
				weekly_budget_tokens: 100,
				monthly_budget_tokens: 100,
			}),
		).toEqual({
			daily_budget_tokens: DAILY,
			weekly_budget_tokens: WEEKLY_FLOOR,
			monthly_budget_tokens: MONTHLY_FLOOR_FROM_DAILY,
		});
	});

	it('never lowers a window already above its floor', () => {
		expect(
			normalizeBudgetWindowsUp({
				daily_budget_tokens: DAILY,
				weekly_budget_tokens: 20000,
				monthly_budget_tokens: 100000,
			}),
		).toEqual({
			daily_budget_tokens: DAILY,
			weekly_budget_tokens: 20000,
			monthly_budget_tokens: 100000,
		});
	});

	it('leaves a disabled longer window at 0 (unlimited)', () => {
		expect(
			normalizeBudgetWindowsUp({
				daily_budget_tokens: DAILY,
				weekly_budget_tokens: 0,
				monthly_budget_tokens: 100,
			}),
		).toEqual({
			daily_budget_tokens: DAILY,
			weekly_budget_tokens: 0,
			monthly_budget_tokens: MONTHLY_FLOOR_FROM_DAILY,
		});
	});
});
