import { describe, expect, it } from 'vitest';
import {
	ALLOWANCE_PACE_RESERVE_PERCENT,
	allowancePace,
	evenDailySharePercent,
	type ProviderAllowance,
	validateAllowanceDailyShare,
} from '../src/allowance-pace';

const WEEK_MIN = 7 * 24 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const START = new Date('2026-09-24T02:42:00Z');
const RESET = new Date(START.getTime() + 7 * DAY_MS);

const week = (usedPercent: number): ProviderAllowance => ({
	usedPercent,
	windowMinutes: WEEK_MIN,
	resetsAt: RESET,
});

const at = (days: number): Date => new Date(START.getTime() + days * DAY_MS);

describe('allowancePace', () => {
	it('spreads a week evenly by default: one seventh a day, one day of it up front', () => {
		const pace = allowancePace(week(0), null, at(0));
		expect(pace?.dailySharePercent).toBeCloseTo(100 / 7);
		expect(pace?.limitPercent).toBeCloseTo(100 / 7);
		expect(pace?.holdUntil).toBeNull();
	});

	it('lets spending on or under the line through', () => {
		// Day 2.5: the line stands at 3.5 days' share.
		expect(allowancePace(week(40), null, at(2.5))?.holdUntil).toBeNull();
		expect(allowancePace(week(49.9), null, at(2.5))?.holdUntil).toBeNull();
	});

	it('holds spending ahead of the line until the line catches up', () => {
		// 24 Sept: about 15% gone within the first hour.
		const pace = allowancePace(week(20), null, at(0.04));
		expect(pace?.holdUntil).not.toBeNull();
		// The line reaches 20% when (days + 1) x 100/7 = 20, i.e. 0.4 days in.
		expect(pace?.holdUntil?.getTime()).toBeCloseTo(at(0.4).getTime(), -3);
	});

	it('uses the admin share in place of the even default', () => {
		const pace = allowancePace(week(35), 20, at(0.5));
		expect(pace?.dailySharePercent).toBe(20);
		expect(pace?.limitPercent).toBeCloseTo(30);
		// 35% is reached at 0.75 days on a 20%-a-day line.
		expect(pace?.holdUntil?.getTime()).toBeCloseTo(at(0.75).getTime(), -3);
	});

	it('keeps the reserve for people: at the cap, work waits for the reset', () => {
		const cap = 100 - ALLOWANCE_PACE_RESERVE_PERCENT;
		const late = allowancePace(week(10), 100, at(6.9));
		expect(late?.limitPercent).toBe(cap);
		expect(allowancePace(week(cap), 100, at(1))?.holdUntil).toEqual(RESET);
	});

	it('paces nothing without a report, after the reset, or on a window shorter than a day', () => {
		expect(allowancePace(null, null, at(1))).toBeNull();
		expect(allowancePace(week(90), null, at(7))).toBeNull();
		const fiveHours: ProviderAllowance = { usedPercent: 90, windowMinutes: 300, resetsAt: RESET };
		expect(allowancePace(fiveHours, null, at(1))).toBeNull();
	});

	it('never holds past the reset', () => {
		const pace = allowancePace(week(94), 5, at(6.5));
		expect(pace?.holdUntil?.getTime()).toBeLessThanOrEqual(RESET.getTime());
	});
});

describe('evenDailySharePercent', () => {
	it('is 100 / days in the window', () => {
		expect(evenDailySharePercent(WEEK_MIN)).toBeCloseTo(100 / 7);
		expect(evenDailySharePercent(2 * 24 * 60)).toBeCloseTo(50);
	});
});

describe('validateAllowanceDailyShare', () => {
	it('accepts null (the even default) and 5-100', () => {
		expect(validateAllowanceDailyShare(null)).toBeNull();
		expect(validateAllowanceDailyShare(5)).toBeNull();
		expect(validateAllowanceDailyShare(14.3)).toBeNull();
		expect(validateAllowanceDailyShare(100)).toBeNull();
	});

	it('refuses a value outside the range or not a number', () => {
		expect(validateAllowanceDailyShare(4)).toMatch(/between 5 and 100/);
		expect(validateAllowanceDailyShare(101)).toMatch(/between 5 and 100/);
		expect(validateAllowanceDailyShare('20')).toMatch(/must be a number/);
		expect(validateAllowanceDailyShare(Number.NaN)).toMatch(/must be a number/);
	});
});
