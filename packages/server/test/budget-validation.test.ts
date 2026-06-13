import {
	centsToDollars,
	dollarsToCents,
	minMonthlyCents,
	minWeeklyCents,
	normalizeBudgetWindowsUp,
	validateBudgetWindows,
} from '@hezo/shared';
import { describe, expect, it } from 'vitest';

// daily $20/day → weekly floor $140, monthly floor ceil(2000*365/12)=60834 cents.
const DAILY = 2000;
const WEEKLY_FLOOR = 14000; // 2000 * 7
const MONTHLY_FLOOR_FROM_DAILY = 60834; // ceil(2000 * 365 / 12)
const WEEKLY = 14000;
const MONTHLY_FLOOR_FROM_WEEKLY = 60667; // ceil(14000 * 52 / 12)

describe('minWeeklyCents', () => {
	it('is daily × 7 when daily is enabled', () => {
		expect(minWeeklyCents(DAILY)).toBe(WEEKLY_FLOOR);
	});
	it('is 0 (no constraint) when daily is disabled', () => {
		expect(minWeeklyCents(0)).toBe(0);
	});
});

describe('minMonthlyCents', () => {
	it('takes the daily-implied floor (ceil of /12)', () => {
		expect(minMonthlyCents(DAILY, 0)).toBe(MONTHLY_FLOOR_FROM_DAILY);
	});
	it('takes the weekly-implied floor when no daily', () => {
		expect(minMonthlyCents(0, WEEKLY)).toBe(MONTHLY_FLOOR_FROM_WEEKLY);
	});
	it('takes the larger of the two when both enabled', () => {
		expect(minMonthlyCents(DAILY, WEEKLY)).toBe(
			Math.max(MONTHLY_FLOOR_FROM_DAILY, MONTHLY_FLOOR_FROM_WEEKLY),
		);
	});
	it('is 0 when both shorter windows are disabled', () => {
		expect(minMonthlyCents(0, 0)).toBe(0);
	});
});

describe('validateBudgetWindows', () => {
	it('accepts a coherent trio exactly at the floors', () => {
		expect(
			validateBudgetWindows({
				daily_budget_cents: DAILY,
				weekly_budget_cents: WEEKLY_FLOOR,
				monthly_budget_cents: MONTHLY_FLOOR_FROM_DAILY,
			}),
		).toEqual([]);
	});

	it('rejects weekly one cent under the daily-implied floor', () => {
		const v = validateBudgetWindows({
			daily_budget_cents: DAILY,
			weekly_budget_cents: WEEKLY_FLOOR - 1,
			monthly_budget_cents: 0,
		});
		expect(v).toHaveLength(1);
		expect(v[0].field).toBe('weekly_budget_cents');
		expect(v[0].minCents).toBe(WEEKLY_FLOOR);
	});

	it('rejects monthly one cent under the floor', () => {
		const v = validateBudgetWindows({
			daily_budget_cents: DAILY,
			weekly_budget_cents: 0,
			monthly_budget_cents: MONTHLY_FLOOR_FROM_DAILY - 1,
		});
		expect(v).toHaveLength(1);
		expect(v[0].field).toBe('monthly_budget_cents');
		expect(v[0].minCents).toBe(MONTHLY_FLOOR_FROM_DAILY);
	});

	it('skips disabled (0) windows', () => {
		// weekly disabled → no weekly constraint; monthly meets the daily floor → valid.
		expect(
			validateBudgetWindows({
				daily_budget_cents: DAILY,
				weekly_budget_cents: 0,
				monthly_budget_cents: MONTHLY_FLOOR_FROM_DAILY,
			}),
		).toEqual([]);
	});

	it('treats an all-disabled trio as valid', () => {
		expect(
			validateBudgetWindows({
				daily_budget_cents: 0,
				weekly_budget_cents: 0,
				monthly_budget_cents: 0,
			}),
		).toEqual([]);
	});
});

describe('normalizeBudgetWindowsUp', () => {
	it('raises dependent longer windows up to their floors', () => {
		expect(
			normalizeBudgetWindowsUp({
				daily_budget_cents: DAILY,
				weekly_budget_cents: 100,
				monthly_budget_cents: 100,
			}),
		).toEqual({
			daily_budget_cents: DAILY,
			weekly_budget_cents: WEEKLY_FLOOR,
			monthly_budget_cents: MONTHLY_FLOOR_FROM_DAILY,
		});
	});

	it('never lowers a window already above its floor', () => {
		expect(
			normalizeBudgetWindowsUp({
				daily_budget_cents: DAILY,
				weekly_budget_cents: 20000,
				monthly_budget_cents: 100000,
			}),
		).toEqual({
			daily_budget_cents: DAILY,
			weekly_budget_cents: 20000,
			monthly_budget_cents: 100000,
		});
	});

	it('leaves a disabled longer window at 0 (unlimited)', () => {
		expect(
			normalizeBudgetWindowsUp({
				daily_budget_cents: DAILY,
				weekly_budget_cents: 0,
				monthly_budget_cents: 100,
			}),
		).toEqual({
			daily_budget_cents: DAILY,
			weekly_budget_cents: 0,
			monthly_budget_cents: MONTHLY_FLOOR_FROM_DAILY,
		});
	});
});

describe('dollar/cents conversion', () => {
	it('centsToDollars formats with two decimals', () => {
		expect(centsToDollars(2000)).toBe('20.00');
		expect(centsToDollars(0)).toBe('0.00');
	});
	it('dollarsToCents parses, rounds, and clamps to >= 0', () => {
		expect(dollarsToCents('20')).toBe(2000);
		expect(dollarsToCents('')).toBe(0);
		expect(dollarsToCents('20.005')).toBe(2001);
		expect(dollarsToCents('-5')).toBe(0);
	});
});
