import { describe, expect, it } from 'vitest';
import {
	centsToDollars,
	containerHoursWindow,
	containerHoursWindowStart,
	dollarsToCents,
	minMonthlyCents,
	minWeeklyCents,
	normalizeBudgetWindowsUp,
	previousContainerHoursWindowStart,
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

describe('containerHoursWindowStart', () => {
	const at = (iso: string) => new Date(iso);

	it('is the first of the calendar month when nothing is anchored', () => {
		expect(containerHoursWindowStart(undefined, at('2026-09-20T13:00:00Z')).toISOString()).toBe(
			'2026-09-01T00:00:00.000Z',
		);
	});

	it('is this month occurrence of the anchor once it has come round', () => {
		expect(containerHoursWindowStart(20, at('2026-09-25T00:00:00Z')).toISOString()).toBe(
			'2026-09-20T00:00:00.000Z',
		);
	});

	it('is last month occurrence before the anchor comes round again', () => {
		expect(containerHoursWindowStart(20, at('2026-09-05T00:00:00Z')).toISOString()).toBe(
			'2026-08-20T00:00:00.000Z',
		);
	});

	// The anchor day itself belongs to the window it opens.
	it('opens the new window on the anchor day itself', () => {
		expect(containerHoursWindowStart(20, at('2026-09-20T00:00:00Z')).toISOString()).toBe(
			'2026-09-20T00:00:00.000Z',
		);
	});

	// **The clamp.** February has no 31st, so a window anchored there opens on
	// the last day it does have rather than rolling into March.
	it('clamps an anchor the month is too short to hold', () => {
		expect(containerHoursWindowStart(31, at('2026-02-28T12:00:00Z')).toISOString()).toBe(
			'2026-02-28T00:00:00.000Z',
		);
		expect(containerHoursWindowStart(31, at('2028-02-29T12:00:00Z')).toISOString()).toBe(
			'2028-02-29T00:00:00.000Z',
		);
	});

	// **Always from the anchor, never from where the last window landed.** Taken
	// off a clamped window, the 31st becomes the 28th and stays there for ever.
	it('comes back to the anchor day after a short month', () => {
		expect(containerHoursWindowStart(31, at('2026-03-31T00:00:00Z')).toISOString()).toBe(
			'2026-03-31T00:00:00.000Z',
		);
		expect(containerHoursWindowStart(31, at('2026-03-30T00:00:00Z')).toISOString()).toBe(
			'2026-02-28T00:00:00.000Z',
		);
	});

	it('steps back into the previous year in January', () => {
		expect(containerHoursWindowStart(15, at('2026-01-05T00:00:00Z')).toISOString()).toBe(
			'2025-12-15T00:00:00.000Z',
		);
	});

	// A stored value outside the range reads as the nearest day rather than
	// wedging the instance: the cap is a ceiling, not a reason to refuse to run.
	it('holds a nonsense anchor to a real day of the month', () => {
		expect(containerHoursWindowStart(0, at('2026-09-05T00:00:00Z')).toISOString()).toBe(
			'2026-09-01T00:00:00.000Z',
		);
		expect(containerHoursWindowStart(99, at('2026-09-05T00:00:00Z')).toISOString()).toBe(
			'2026-08-31T00:00:00.000Z',
		);
	});

	// Whatever the anchor, the window it names has already begun.
	it('never opens a window that has not started', () => {
		for (const day of [1, 15, 28, 29, 30, 31]) {
			for (const now of ['2026-01-01', '2026-02-28', '2026-03-01', '2026-12-31']) {
				const when = at(`${now}T12:00:00Z`);
				expect(containerHoursWindowStart(day, when).getTime()).toBeLessThanOrEqual(when.getTime());
			}
		}
	});
});

/**
 * The two bounds a reader needs, and the one before them.
 *
 * Both are built on the clamped start rather than by adding a month to
 * something, which is the arithmetic that walks an anniversary backwards a day
 * at a time through every short month.
 */
describe('containerHoursWindow', () => {
	const at = (iso: string) => new Date(iso);

	it('runs from the anchor to the next occurrence of it', () => {
		const { start, end } = containerHoursWindow(20, at('2026-09-25T00:00:00Z'));
		expect(start.toISOString()).toBe('2026-09-20T00:00:00.000Z');
		expect(end.toISOString()).toBe('2026-10-20T00:00:00.000Z');
	});

	it('is the calendar month when nothing is anchored', () => {
		const { start, end } = containerHoursWindow(undefined, at('2026-09-20T13:00:00Z'));
		expect(start.toISOString()).toBe('2026-09-01T00:00:00.000Z');
		expect(end.toISOString()).toBe('2026-10-01T00:00:00.000Z');
	});

	// **The clamp, on the far end too.** A window opened on the 31st of January
	// ends on the 28th of February, and the one after it opens on the 31st of
	// March - never the 28th for ever after.
	it('clamps the end into a month too short to hold the anchor', () => {
		const january = containerHoursWindow(31, at('2026-01-31T06:00:00Z'));
		expect(january.start.toISOString()).toBe('2026-01-31T00:00:00.000Z');
		expect(january.end.toISOString()).toBe('2026-02-28T00:00:00.000Z');

		// And the anniversary comes back, rather than staying where it was clamped.
		expect(containerHoursWindow(31, at('2026-03-31T06:00:00Z')).start.toISOString()).toBe(
			'2026-03-31T00:00:00.000Z',
		);
	});

	it('ends where the next window starts, so no instant belongs to neither', () => {
		const { end } = containerHoursWindow(20, at('2026-09-25T00:00:00Z'));
		expect(containerHoursWindowStart(20, end).toISOString()).toBe(end.toISOString());
	});
});

describe('previousContainerHoursWindowStart', () => {
	const at = (iso: string) => new Date(iso);

	it('is the window the instant before this one belongs to', () => {
		expect(previousContainerHoursWindowStart(20, at('2026-09-25T00:00:00Z')).toISOString()).toBe(
			'2026-08-20T00:00:00.000Z',
		);
	});

	it('steps back a calendar month when nothing is anchored', () => {
		expect(
			previousContainerHoursWindowStart(undefined, at('2026-09-20T13:00:00Z')).toISOString(),
		).toBe('2026-08-01T00:00:00.000Z');
	});

	// Stepping back from a clamped window lands on the anchor's own day, not on
	// the day the clamp moved it to.
	it('steps back out of a clamped window onto the anchor itself', () => {
		expect(previousContainerHoursWindowStart(31, at('2026-02-28T12:00:00Z')).toISOString()).toBe(
			'2026-01-31T00:00:00.000Z',
		);
	});
});
