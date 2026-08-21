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
