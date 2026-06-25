import { describe, expect, it } from 'vitest';
import {
	centsToDollars,
	dollarsToCents,
	minMonthlyCents,
	minWeeklyCents,
	normalizeBudgetWindowsUp,
	validateBudgetWindows,
} from '../src/budget';

describe('centsToDollars / dollarsToCents', () => {
	it('formats cents as fixed-2 dollars', () => {
		expect(centsToDollars(2000)).toBe('20.00');
		expect(centsToDollars(199)).toBe('1.99');
		expect(centsToDollars(0)).toBe('0.00');
	});

	it('parses dollar strings to non-negative integer cents', () => {
		expect(dollarsToCents('20')).toBe(2000);
		expect(dollarsToCents('1.999')).toBe(200);
		expect(dollarsToCents('')).toBe(0);
		expect(dollarsToCents('abc')).toBe(0);
		expect(dollarsToCents('-5')).toBe(0);
	});
});

describe('window floors', () => {
	it('minWeeklyCents is daily × 7, or 0 when daily is unlimited', () => {
		expect(minWeeklyCents(100)).toBe(700);
		expect(minWeeklyCents(0)).toBe(0);
	});

	it('minMonthlyCents takes the larger of the daily/weekly implied floors', () => {
		expect(minMonthlyCents(100, 0)).toBe(3042); // ceil(100 * 365/12)
		expect(minMonthlyCents(0, 1000)).toBe(4334); // ceil(1000 * 52/12)
		expect(minMonthlyCents(0, 0)).toBe(0);
	});
});

describe('validateBudgetWindows', () => {
	it('returns no violations for a coherent trio (or all-disabled)', () => {
		expect(
			validateBudgetWindows({
				daily_budget_cents: 100,
				weekly_budget_cents: 700,
				monthly_budget_cents: 3042,
			}),
		).toEqual([]);
		expect(
			validateBudgetWindows({
				daily_budget_cents: 0,
				weekly_budget_cents: 0,
				monthly_budget_cents: 0,
			}),
		).toEqual([]);
	});

	it('flags a weekly budget below the daily-implied floor', () => {
		const v = validateBudgetWindows({
			daily_budget_cents: 100,
			weekly_budget_cents: 500,
			monthly_budget_cents: 0,
		});
		expect(v).toHaveLength(1);
		expect(v[0]).toMatchObject({ field: 'weekly_budget_cents', minCents: 700 });
	});

	it('flags a monthly budget below the weekly-implied floor', () => {
		const v = validateBudgetWindows({
			daily_budget_cents: 0,
			weekly_budget_cents: 1000,
			monthly_budget_cents: 1000,
		});
		expect(v).toHaveLength(1);
		expect(v[0]).toMatchObject({ field: 'monthly_budget_cents', minCents: 4334 });
		expect(v[0].message).toContain('weekly budget (weekly × 52/12)');
	});
});

describe('normalizeBudgetWindowsUp', () => {
	it('raises enabled longer windows up to their floors', () => {
		expect(
			normalizeBudgetWindowsUp({
				daily_budget_cents: 100,
				weekly_budget_cents: 500,
				monthly_budget_cents: 0,
			}),
		).toEqual({ daily_budget_cents: 100, weekly_budget_cents: 700, monthly_budget_cents: 0 });
	});

	it('feeds the daily floor into the monthly when weekly is disabled', () => {
		expect(
			normalizeBudgetWindowsUp({
				daily_budget_cents: 100,
				weekly_budget_cents: 0,
				monthly_budget_cents: 1000,
			}),
		).toEqual({ daily_budget_cents: 100, weekly_budget_cents: 0, monthly_budget_cents: 3042 });
	});

	it('leaves a coherent trio unchanged', () => {
		const coherent = {
			daily_budget_cents: 100,
			weekly_budget_cents: 700,
			monthly_budget_cents: 3042,
		};
		expect(normalizeBudgetWindowsUp(coherent)).toEqual(coherent);
	});
});
