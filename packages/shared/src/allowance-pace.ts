/**
 * Pacing a subscription credential's spend across its provider's usage window.
 *
 * A subscription's allowance is a window (a week, for Codex) that the provider
 * meters in its own unit and reports as a percent used, with the time it resets.
 * Nothing about a run, a task or an agent bounds how fast a whole instance spends
 * that window, so a refilled allowance can go in hours. The pace line bounds it:
 * the percent the credential may have used by now, rising a fixed share per day
 * from the window's start.
 *
 * The rule lives here, once, because three places read it: the dispatch gate
 * that holds work ahead of the line, the credential dialog that shows where the
 * week stands, and the notice that tells the admin work is being held.
 */

/** A credential's usage window as its provider last reported it. */
export interface ProviderAllowance {
	/** How much of the window is used, 0-100, in the provider's own unit. */
	usedPercent: number;
	/** The window's length in minutes (10,080 for a week). */
	windowMinutes: number;
	/** When the provider says the window resets. */
	resetsAt: Date;
}

/**
 * The share of every window kept back for runs a person asks for. The pace line
 * never rises past `100 - this`, so an admin's Run now still has allowance left
 * when the agents have spent theirs.
 */
export const ALLOWANCE_PACE_RESERVE_PERCENT = 5;

/** The smallest daily share an admin may set, as a percent of the window. */
export const ALLOWANCE_DAILY_SHARE_MIN_PERCENT = 5;

/** The largest daily share: the whole window in one day, which paces nothing. */
export const ALLOWANCE_DAILY_SHARE_MAX_PERCENT = 100;

/**
 * Windows shorter than this are not paced. A daily share of a five-hour window
 * means nothing; such a window clears on its own clock, and the refusal hold
 * already waits it out.
 */
export const ALLOWANCE_MIN_PACED_WINDOW_MINUTES = 24 * 60;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The daily share that spreads a window evenly over its length. */
export function evenDailySharePercent(windowMinutes: number): number {
	return (100 * DAY_MS) / (windowMinutes * 60_000);
}

/** Where a credential's window stands against its pace line. */
export interface AllowancePace {
	/** The percent used, as last reported. */
	usedPercent: number;
	/** The percent the pace line allows by now. */
	limitPercent: number;
	/** The daily share in force: the admin's setting, or the even default. */
	dailySharePercent: number;
	/** When the window resets. */
	resetsAt: Date;
	/**
	 * When the line reaches the percent used, or the reset once the reserve is
	 * reached. Null while spending is on or under the line.
	 */
	holdUntil: Date | null;
}

/**
 * The pace line for a credential's window, or null when there is nothing to pace:
 * no report yet, a window shorter than a day, or a report whose window has
 * already reset.
 *
 * The line is `share x (days elapsed + 1)`, capped at the reserve. One day's share
 * is there from the first minute of a window, and a share not spent carries
 * forward, so the whole window is still usable by its end.
 */
export function allowancePace(
	allowance: ProviderAllowance | null,
	dailySharePercent: number | null,
	now: Date,
): AllowancePace | null {
	if (!allowance) return null;
	if (allowance.windowMinutes < ALLOWANCE_MIN_PACED_WINDOW_MINUTES) return null;
	const resetsAtMs = allowance.resetsAt.getTime();
	if (!Number.isFinite(resetsAtMs) || now.getTime() >= resetsAtMs) return null;

	const share = dailySharePercent ?? evenDailySharePercent(allowance.windowMinutes);
	const cap = 100 - ALLOWANCE_PACE_RESERVE_PERCENT;
	const startMs = resetsAtMs - allowance.windowMinutes * 60_000;
	const elapsedDays = Math.max(0, (now.getTime() - startMs) / DAY_MS);
	const limitPercent = Math.min(cap, share * (elapsedDays + 1));

	let holdUntil: Date | null = null;
	if (allowance.usedPercent >= cap) {
		holdUntil = new Date(resetsAtMs);
	} else if (allowance.usedPercent >= limitPercent) {
		// The line reaches `used` when share x (days + 1) = used.
		const reachMs = startMs + (allowance.usedPercent / share - 1) * DAY_MS;
		holdUntil = new Date(Math.min(resetsAtMs, Math.max(now.getTime(), reachMs)));
	}

	return {
		usedPercent: allowance.usedPercent,
		limitPercent,
		dailySharePercent: share,
		resetsAt: allowance.resetsAt,
		holdUntil,
	};
}

/**
 * Why a daily share cannot be stored, or null when it can. Null clears the
 * setting back to the even default. The one rule, for the credential dialog's
 * feedback and for the route that enforces it.
 */
export function validateAllowanceDailyShare(value: unknown): string | null {
	if (value === null) return null;
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return 'allowance_daily_share_percent must be a number, or null for the even default';
	}
	if (value < ALLOWANCE_DAILY_SHARE_MIN_PERCENT || value > ALLOWANCE_DAILY_SHARE_MAX_PERCENT) {
		return `allowance_daily_share_percent must be between ${ALLOWANCE_DAILY_SHARE_MIN_PERCENT} and ${ALLOWANCE_DAILY_SHARE_MAX_PERCENT}`;
	}
	return null;
}
