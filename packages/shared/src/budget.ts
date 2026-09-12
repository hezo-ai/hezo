/**
 * Budget window math — the single source of truth for the daily/weekly/monthly
 * rolling spend caps on agents and projects. Imported by the web forms, every
 * backend write path, and the tests so the rules live in exactly one place.
 *
 * 0 = unlimited/disabled for a window and is skipped by every check. Longer
 * windows must be consistent with shorter ones: a longer window can't be set
 * below what the shorter window's rate implies over the same span —
 *   weekly  >= daily  * 7
 *   monthly >= daily  * 365/12
 *   monthly >= weekly * 52/12
 */

/**
 * The monthly cap a newly hired agent starts with, in cents. **0 is unlimited**,
 * and that is the default.
 *
 * It used to be 3000. Nothing chose that figure, and until cache traffic was
 * priced at real rates it bit several times sooner than its face value read - so
 * a team could stop working for a reason its operator never set and could not
 * see. Projects have defaulted to unlimited since the baseline schema; agents now
 * match, and an operator who wants a cap sets one.
 *
 * Stated once here because four call sites had the old figure written out
 * separately - the hire proposal, both agent-create paths, and the hire form -
 * and a default spelled four times is a default that changes in three places.
 */
export const DEFAULT_MONTHLY_BUDGET_CENTS = 0;

export interface BudgetWindowsCents {
	daily_budget_cents: number;
	weekly_budget_cents: number;
	monthly_budget_cents: number;
}

const DAYS_PER_WEEK = 7;
const DAYS_PER_MONTH = 365 / 12; // average calendar month
const WEEKS_PER_MONTH = 52 / 12;

/** A window with a 0 limit is unlimited/disabled and never constrains anything. */
function isEnabled(cents: number): boolean {
	return cents > 0;
}

/** Cents → fixed-2 dollar string, e.g. 2000 → "20.00". */
export function centsToDollars(cents: number): string {
	return (cents / 100).toFixed(2);
}

/** Parse a dollar input string → non-negative integer cents. Empty/NaN → 0. */
export function dollarsToCents(input: string): number {
	const parsed = Number.parseFloat(input || '0');
	if (!Number.isFinite(parsed)) return 0;
	return Math.max(0, Math.round(parsed * 100));
}

/** Minimum weekly cents implied by the daily cap (daily × 7). 0 when daily is unlimited. */
export function minWeeklyCents(dailyCents: number): number {
	return isEnabled(dailyCents) ? dailyCents * DAYS_PER_WEEK : 0;
}

/**
 * Minimum monthly cents implied by the daily and/or weekly caps — the larger of
 * daily × 365/12 and weekly × 52/12, over whichever are enabled. 0 when neither is.
 */
export function minMonthlyCents(dailyCents: number, weeklyCents: number): number {
	let min = 0;
	if (isEnabled(dailyCents)) min = Math.max(min, Math.ceil(dailyCents * DAYS_PER_MONTH));
	if (isEnabled(weeklyCents)) min = Math.max(min, Math.ceil(weeklyCents * WEEKS_PER_MONTH));
	return min;
}

export interface BudgetViolation {
	field: 'weekly_budget_cents' | 'monthly_budget_cents';
	minCents: number;
	message: string;
}

/**
 * All cross-window violations for a trio. Empty array means coherent. Disabled
 * (0) windows are skipped. Comparisons use the same ceil-based floors as
 * `minWeeklyCents`/`minMonthlyCents`, so client and server agree to the cent.
 */
export function validateBudgetWindows(w: BudgetWindowsCents): BudgetViolation[] {
	const violations: BudgetViolation[] = [];

	const weeklyFloor = minWeeklyCents(w.daily_budget_cents);
	if (isEnabled(w.weekly_budget_cents) && w.weekly_budget_cents < weeklyFloor) {
		violations.push({
			field: 'weekly_budget_cents',
			minCents: weeklyFloor,
			message: `Weekly budget must be at least $${centsToDollars(weeklyFloor)} to cover the daily budget (daily × 7).`,
		});
	}

	const monthlyFloor = minMonthlyCents(w.daily_budget_cents, w.weekly_budget_cents);
	if (isEnabled(w.monthly_budget_cents) && w.monthly_budget_cents < monthlyFloor) {
		// Name whichever shorter window binds the floor, for a clearer message.
		const dailyImplied = isEnabled(w.daily_budget_cents)
			? Math.ceil(w.daily_budget_cents * DAYS_PER_MONTH)
			: 0;
		const weeklyImplied = isEnabled(w.weekly_budget_cents)
			? Math.ceil(w.weekly_budget_cents * WEEKS_PER_MONTH)
			: 0;
		const basis =
			dailyImplied >= weeklyImplied
				? 'daily budget (daily × 365/12)'
				: 'weekly budget (weekly × 52/12)';
		violations.push({
			field: 'monthly_budget_cents',
			minCents: monthlyFloor,
			message: `Monthly budget must be at least $${centsToDollars(monthlyFloor)} to cover the ${basis}.`,
		});
	}

	return violations;
}

/**
 * Raise (never lower) each enabled longer window up to its floor so the trio is
 * coherent. Processes daily → weekly → monthly so the raised weekly feeds the
 * monthly floor. Used by the web editor for live auto-raise as the user types.
 */
export function normalizeBudgetWindowsUp(w: BudgetWindowsCents): BudgetWindowsCents {
	const weekly = isEnabled(w.weekly_budget_cents)
		? Math.max(w.weekly_budget_cents, minWeeklyCents(w.daily_budget_cents))
		: w.weekly_budget_cents;
	const monthly = isEnabled(w.monthly_budget_cents)
		? Math.max(w.monthly_budget_cents, minMonthlyCents(w.daily_budget_cents, weekly))
		: w.monthly_budget_cents;
	return {
		daily_budget_cents: w.daily_budget_cents,
		weekly_budget_cents: weekly,
		monthly_budget_cents: monthly,
	};
}

/**
 * The lowest and highest day of the month a container-hours window may be
 * anchored on.
 *
 * 31 is admitted even though seven months are shorter: the anchor is a day the
 * deployer names, and clamping it to 28 so every month is uniform would move the
 * anniversary of everyone anchored later in the month.
 */
export const CONTAINER_HOURS_ANCHOR_MIN_DAY = 1;
export const CONTAINER_HOURS_ANCHOR_MAX_DAY = 31;

/**
 * A day of the month as it falls in one particular month, or that month's last
 * day where it is too short to hold it.
 *
 * **Always from the anchor, never from wherever the last window landed.** Taking
 * the day off a window that had already been clamped is how an anniversary walks
 * backwards: the 31st becomes the 28th in February, and every month after that
 * is the 28th for ever.
 */
function occurrenceInMonth(year: number, month: number, day: number): Date {
	// Day zero of the next month is the last day of this one.
	const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
	return new Date(Date.UTC(year, month, Math.min(day, lastDay)));
}

/**
 * When the container-hours window containing `now` began.
 *
 * **The calendar month unless a deployer anchored it**, which is what an unset
 * anchor gives and what this has always done — a local instance and a
 * self-hosted one both want the first of the month.
 *
 * A hosted instance is billed on the day it subscribed, and a pool resetting on
 * the 1st would hand a tenant who bought on the 20th a third of their first
 * month at the full price of it. The anchor is a day rather than a date so it
 * survives being pinned once and read for ever.
 */
export function containerHoursWindowStart(anchorDay: number | undefined, now: Date): Date {
	const year = now.getUTCFullYear();
	const month = now.getUTCMonth();
	if (anchorDay === undefined) return new Date(Date.UTC(year, month, 1));

	const day = Math.min(
		Math.max(Math.trunc(anchorDay), CONTAINER_HOURS_ANCHOR_MIN_DAY),
		CONTAINER_HOURS_ANCHOR_MAX_DAY,
	);
	const thisMonth = occurrenceInMonth(year, month, day);
	// Before the anchor has come round this month, the window began last month —
	// and `Date.UTC` takes month -1 as December of the year before.
	return thisMonth.getTime() <= now.getTime() ? thisMonth : occurrenceInMonth(year, month - 1, day);
}

/**
 * How far past a window's start to look for the next one.
 *
 * **Longer than any month, shorter than two.** Landing anywhere inside the
 * following month is enough, because the clamped arithmetic above then finds
 * that month's own occurrence of the anchor day - so this only has to clear a
 * 31-day month without reaching the month after.
 */
const MONTH_STRIDE_DAYS = 32;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The container-hours window containing `now`: when it opened, and when it ends.
 *
 * **The bound a reader needs, not one they derive.** The cap is enforced against
 * the window, so any surface naming what is left has to name the same period -
 * and a page adding a month to the start would disagree with the gate in every
 * short month. Both bounds come from the one clamped helper, so a window opened
 * on the 31st ends on the 28th of a February and the one after it opens on the
 * 31st again.
 *
 * The end is exclusive: it is the instant the next window opens.
 */
export function containerHoursWindow(
	anchorDay: number | undefined,
	now: Date,
): { start: Date; end: Date } {
	const start = containerHoursWindowStart(anchorDay, now);
	return {
		start,
		end: containerHoursWindowStart(
			anchorDay,
			new Date(start.getTime() + MONTH_STRIDE_DAYS * DAY_MS),
		),
	};
}

/**
 * When the window before the one containing `now` opened.
 *
 * One millisecond before this window began is, by definition, inside the one
 * before it - so the same clamped helper answers it, rather than a second copy
 * of the month arithmetic that could disagree with the first.
 */
export function previousContainerHoursWindowStart(anchorDay: number | undefined, now: Date): Date {
	const start = containerHoursWindowStart(anchorDay, now);
	return containerHoursWindowStart(anchorDay, new Date(start.getTime() - 1));
}
