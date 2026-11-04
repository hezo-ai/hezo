import { englishCount } from './i18n/format.js';
/**
 * Budget window math - the single source of truth for the daily/weekly/monthly
 * caps: tokens on agents and projects, and container-hours on projects. Imported
 * by the web forms, every backend write path, and the tests so the rules live in
 * exactly one place.
 *
 * A token budget counts every token a run sent and received: input, cached input
 * included, plus output. An hours budget counts the seconds a project's
 * containers were up. 0 = unlimited/disabled for a window and is skipped by
 * every check. Longer windows must be consistent with shorter ones, whatever the
 * unit: a longer window can't be set below what the shorter window's rate
 * implies over the same span -
 *   weekly  >= daily  * 7
 *   monthly >= daily  * 365/12
 *   monthly >= weekly * 52/12
 */

/**
 * The monthly cap a newly hired agent starts with, in tokens. **0 is unlimited**,
 * and that is the default: an operator who wants a cap sets one.
 *
 * Stated once here because four call sites need it - the hire proposal, both
 * agent-create paths, and the hire form - and a default spelled four times is a
 * default that changes in three places.
 */
export const DEFAULT_MONTHLY_BUDGET_TOKENS = 0;

export interface BudgetWindowsTokens {
	daily_budget_tokens: number;
	weekly_budget_tokens: number;
	monthly_budget_tokens: number;
}

/** The three window fields, in the order a person reads them. */
export const BUDGET_WINDOW_FIELDS = [
	'daily_budget_tokens',
	'weekly_budget_tokens',
	'monthly_budget_tokens',
] as const satisfies readonly (keyof BudgetWindowsTokens)[];

/**
 * The dollar fields budgets used before they counted tokens, each mapped to the
 * field that replaced it. A request still sending one is refused with the
 * replacement's name rather than having the field ignored in silence.
 */
export const RETIRED_BUDGET_FIELDS: Readonly<Record<string, keyof BudgetWindowsTokens>> = {
	daily_budget_cents: 'daily_budget_tokens',
	weekly_budget_cents: 'weekly_budget_tokens',
	monthly_budget_cents: 'monthly_budget_tokens',
};

/**
 * How a retired dollar field is refused, in one sentence - the one wording, for a
 * body checked field by field and for a schema that refuses one field at a time.
 */
export function retiredBudgetFieldMessage(
	fields: readonly (keyof typeof RETIRED_BUDGET_FIELDS)[],
): string {
	const pairs = fields.map((field) => `${field} -> ${RETIRED_BUDGET_FIELDS[field]}`).join(', ');
	return `Budgets are counted in tokens, not dollars. Send ${pairs} instead.`;
}

/**
 * The refusal for a body carrying a retired dollar budget field, or null when it
 * carries none. Checked by every route and tool that writes a budget.
 */
export function retiredBudgetFieldError(body: unknown): string | null {
	if (!body || typeof body !== 'object') return null;
	const found = Object.keys(RETIRED_BUDGET_FIELDS).filter((field) => field in body);
	if (found.length === 0) return null;
	return retiredBudgetFieldMessage(found);
}

/** A token budget as an English sentence names it: "unlimited" for 0, else the count. */
export function describeTokenBudget(tokens: number): string {
	return tokens > 0 ? `${englishCount(tokens)} tokens` : 'unlimited';
}

const DAYS_PER_WEEK = 7;
const DAYS_PER_MONTH = 365 / 12; // average calendar month
const WEEKS_PER_MONTH = 52 / 12;

/**
 * A daily/weekly/monthly budget in one unit, before it is named for a column.
 *
 * The floor rules below hold for every budget whatever it counts - tokens on an
 * agent or a project, container-seconds on a project - so they are written once
 * against this shape, and each budget maps its own field names onto it.
 */
export interface BudgetWindows {
	daily: number;
	weekly: number;
	monthly: number;
}

/** A window with a 0 limit is unlimited/disabled and never constrains anything. */
function isEnabled(limit: number): boolean {
	return limit > 0;
}

/** Minimum weekly limit implied by the daily one (daily × 7). 0 when daily is unlimited. */
export function minWeeklyLimit(daily: number): number {
	return isEnabled(daily) ? daily * DAYS_PER_WEEK : 0;
}

/**
 * Minimum monthly limit implied by the daily and/or weekly ones - the larger of
 * daily × 365/12 and weekly × 52/12, over whichever are enabled. 0 when neither is.
 */
export function minMonthlyLimit(daily: number, weekly: number): number {
	let min = 0;
	if (isEnabled(daily)) min = Math.max(min, Math.ceil(daily * DAYS_PER_MONTH));
	if (isEnabled(weekly)) min = Math.max(min, Math.ceil(weekly * WEEKS_PER_MONTH));
	return min;
}

/** Minimum weekly tokens implied by the daily cap (daily × 7). 0 when daily is unlimited. */
export function minWeeklyTokens(dailyTokens: number): number {
	return minWeeklyLimit(dailyTokens);
}

/**
 * Minimum monthly tokens implied by the daily and/or weekly caps - the larger of
 * daily × 365/12 and weekly × 52/12, over whichever are enabled. 0 when neither is.
 */
export function minMonthlyTokens(dailyTokens: number, weeklyTokens: number): number {
	return minMonthlyLimit(dailyTokens, weeklyTokens);
}

/** Where a longer window's floor comes from. */
type FloorBasis = 'weekFromDay' | 'monthFromDay' | 'monthFromWeek';

/** Which longer window broke a floor, and the floor it broke, in the budget's own unit. */
export interface WindowViolation {
	window: 'weekly' | 'monthly';
	min: number;
	/** The shorter window the floor comes from, for the message. */
	basis: FloorBasis;
}

/**
 * All cross-window violations for a trio, in any unit. Empty means coherent.
 * Disabled (0) windows are skipped. Comparisons use the same ceil-based floors as
 * {@link minWeeklyLimit}/{@link minMonthlyLimit}, so client and server agree to
 * the unit.
 */
export function windowViolations(w: BudgetWindows): WindowViolation[] {
	const violations: WindowViolation[] = [];

	const weeklyFloor = minWeeklyLimit(w.daily);
	if (isEnabled(w.weekly) && w.weekly < weeklyFloor) {
		violations.push({ window: 'weekly', min: weeklyFloor, basis: 'weekFromDay' });
	}

	const monthlyFloor = minMonthlyLimit(w.daily, w.weekly);
	if (isEnabled(w.monthly) && w.monthly < monthlyFloor) {
		// Name whichever shorter window binds the floor, for a clearer message.
		const dailyImplied = isEnabled(w.daily) ? Math.ceil(w.daily * DAYS_PER_MONTH) : 0;
		const weeklyImplied = isEnabled(w.weekly) ? Math.ceil(w.weekly * WEEKS_PER_MONTH) : 0;
		violations.push({
			window: 'monthly',
			min: monthlyFloor,
			basis: dailyImplied >= weeklyImplied ? 'monthFromDay' : 'monthFromWeek',
		});
	}

	return violations;
}

/**
 * Raise (never lower) each enabled longer window up to its floor so the trio is
 * coherent, in any unit. Processes daily → weekly → monthly so the raised weekly
 * feeds the monthly floor.
 */
export function normalizeWindowsUp(w: BudgetWindows): BudgetWindows {
	const weekly = isEnabled(w.weekly) ? Math.max(w.weekly, minWeeklyLimit(w.daily)) : w.weekly;
	const monthly = isEnabled(w.monthly)
		? Math.max(w.monthly, minMonthlyLimit(w.daily, weekly))
		: w.monthly;
	return { daily: w.daily, weekly, monthly };
}

/** How each floor's basis reads in a refusal. */
const VIOLATION_BASIS: Record<FloorBasis, string> = {
	weekFromDay: 'daily budget (daily × 7)',
	monthFromDay: 'daily budget (daily × 365/12)',
	monthFromWeek: 'weekly budget (weekly × 52/12)',
};

/** The window names a refusal opens with. */
const VIOLATION_WINDOW: Record<WindowViolation['window'], string> = {
	weekly: 'Weekly',
	monthly: 'Monthly',
};

export interface BudgetViolation {
	field: 'weekly_budget_tokens' | 'monthly_budget_tokens';
	minTokens: number;
	message: string;
}

/** A token trio as the unit-free trio the floor rules read. */
function tokenWindows(w: BudgetWindowsTokens): BudgetWindows {
	return {
		daily: w.daily_budget_tokens,
		weekly: w.weekly_budget_tokens,
		monthly: w.monthly_budget_tokens,
	};
}

/**
 * All cross-window violations for a token trio. Empty array means coherent.
 * Disabled (0) windows are skipped.
 */
export function validateBudgetWindows(w: BudgetWindowsTokens): BudgetViolation[] {
	return windowViolations(tokenWindows(w)).map((v) => ({
		field: `${v.window}_budget_tokens` as const,
		minTokens: v.min,
		message: `${VIOLATION_WINDOW[v.window]} budget must be at least ${englishCount(v.min)} tokens to cover the ${VIOLATION_BASIS[v.basis]}.`,
	}));
}

/**
 * Raise (never lower) each enabled longer window up to its floor so the trio is
 * coherent. Processes daily → weekly → monthly so the raised weekly feeds the
 * monthly floor. Used by the web editor for live auto-raise as the user types.
 */
export function normalizeBudgetWindowsUp(w: BudgetWindowsTokens): BudgetWindowsTokens {
	const n = normalizeWindowsUp(tokenWindows(w));
	return {
		daily_budget_tokens: n.daily,
		weekly_budget_tokens: n.weekly,
		monthly_budget_tokens: n.monthly,
	};
}

/**
 * A project's hours budget: how many container-seconds its containers may be up
 * in each window, 0 for no limit. Counted in seconds because the uptime ledger
 * is, so the gate compares like with like and nothing is rounded twice; every
 * surface shows and takes hours.
 *
 * Daily and weekly are the UTC day and ISO week, as the token budget's are.
 * **Monthly is the container-hours window**, the instance allowance's own
 * period: a project's month and the pool it draws from always cover the same
 * days, which is the billing period wherever a deployer anchored one.
 *
 * Projects only, and never HQ: HQ draws on the instance allowance itself.
 */
export interface BudgetWindowsContainerSeconds {
	daily_budget_container_seconds: number;
	weekly_budget_container_seconds: number;
	monthly_budget_container_seconds: number;
}

/** The three hours-budget fields, in the order a person reads them. */
export const CONTAINER_HOURS_BUDGET_FIELDS = [
	'daily_budget_container_seconds',
	'weekly_budget_container_seconds',
	'monthly_budget_container_seconds',
] as const satisfies readonly (keyof BudgetWindowsContainerSeconds)[];

/** An hours trio as the unit-free trio the floor rules read. */
export function containerSecondsWindows(w: BudgetWindowsContainerSeconds): BudgetWindows {
	return {
		daily: w.daily_budget_container_seconds,
		weekly: w.weekly_budget_container_seconds,
		monthly: w.monthly_budget_container_seconds,
	};
}

/** Seconds in an hour - the unit the ledger counts and the unit a person reads. */
export const SECONDS_PER_HOUR = 3600;

/**
 * Container-seconds as the hours a person types, rounded **up** to two decimals.
 *
 * Up, because the figure this names is usually a floor: an hour count rounded to
 * the nearest hundredth can land a few seconds under the floor it states, and
 * typing back what a refusal asked for would be refused again.
 */
export function containerSecondsToHours(seconds: number): number {
	return Math.ceil(seconds / (SECONDS_PER_HOUR / 100)) / 100;
}

/** A refusal for an incoherent hours trio, or an empty list. */
export function validateContainerHoursBudgetWindows(w: BudgetWindowsContainerSeconds): {
	field: (typeof CONTAINER_HOURS_BUDGET_FIELDS)[number];
	minSeconds: number;
	message: string;
}[] {
	return windowViolations(containerSecondsWindows(w)).map((v) => ({
		field: `${v.window}_budget_container_seconds` as const,
		minSeconds: v.min,
		message: `${VIOLATION_WINDOW[v.window]} hours budget must be at least ${containerSecondsToHours(v.min)} hours (${v.min} seconds) to cover the ${VIOLATION_BASIS[v.basis]}.`,
	}));
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
export function containerHoursWindowStart(
	anchorDay: number | undefined,
	now: Date,
	since?: Date,
): Date {
	const natural = anchoredWindowStart(anchorDay, now);
	return since !== undefined && since.getTime() > natural.getTime() ? since : natural;
}

/**
 * The window's start from the anchor alone, before any `since` holds it back.
 *
 * **`since` moves where a window starts counting, never where it ends.** A
 * deployer that bills from the moment someone bought pins that instant; the
 * first window then counts from it rather than from midnight on the anchor day,
 * and every window after it opens on the anchor as before.
 */
function anchoredWindowStart(anchorDay: number | undefined, now: Date): Date {
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
	since?: Date,
): { start: Date; end: Date } {
	const anchored = anchoredWindowStart(anchorDay, now);
	return {
		start: containerHoursWindowStart(anchorDay, now, since),
		end: anchoredWindowStart(anchorDay, new Date(anchored.getTime() + MONTH_STRIDE_DAYS * DAY_MS)),
	};
}

/**
 * When the window before the one containing `now` opened.
 *
 * One millisecond before this window began is, by definition, inside the one
 * before it - so the same clamped helper answers it, rather than a second copy
 * of the month arithmetic that could disagree with the first.
 */
export function previousContainerHoursWindowStart(
	anchorDay: number | undefined,
	now: Date,
	since?: Date,
): Date {
	const start = containerHoursWindowStart(anchorDay, now, since);
	const previous = containerHoursWindowStart(
		anchorDay,
		new Date(anchoredWindowStart(anchorDay, now).getTime() - 1),
		since,
	);
	// Nothing before `since` is counted, so a window that has none before it
	// reads as empty rather than as the hours that preceded it.
	return previous.getTime() < start.getTime() ? previous : start;
}

/**
 * The shapes a usage read answers with, on both sides of the wire: the server
 * selects them, the web renders them, and a rename is a compile error in both
 * rather than a blank column in one.
 */

/** A token sum as every usage read reports it: input (cache included), output, total. */
export interface UsageTotals {
	input_tokens: number;
	output_tokens: number;
	total_tokens: number;
}

/** One agent's usage, as a read grouped by agent returns it. */
export interface AgentUsageRow extends UsageTotals {
	agent_id: string;
	agent_title: string | null;
	/** The agent's own name, when it has one. Null means it goes by its role. */
	agent_name: string | null;
}

/** Usage against a limit for one window. `overBudget` requires a positive limit. */
export interface WindowStatus {
	usedTokens: number;
	limitTokens: number;
	overBudget: boolean;
}

/** Per-window status for one entity (an agent or a project) plus an aggregate flag. */
export interface EntityBudgetStatus {
	daily: WindowStatus;
	weekly: WindowStatus;
	monthly: WindowStatus;
	/** True when any window is over budget. */
	overBudget: boolean;
}

/** One window of a project's hours budget: container-seconds used against the limit. */
export interface ContainerHoursWindowStatus {
	used_seconds: number;
	/** 0 is no limit. */
	limit_seconds: number;
	/** True only when a positive limit is met or exceeded. */
	over_budget: boolean;
}

/**
 * A project's hours budget against what its containers used, as the project's
 * hours route answers it. Monthly is the container-hours window, whose end the
 * same response carries as `totals.window_end`.
 */
export interface ProjectContainerHoursBudget {
	daily: ContainerHoursWindowStatus;
	weekly: ContainerHoursWindowStatus;
	monthly: ContainerHoursWindowStatus;
	/** True when any window is over budget. */
	over_budget: boolean;
}
