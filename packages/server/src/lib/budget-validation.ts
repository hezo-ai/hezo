import {
	BUDGET_WINDOW_FIELDS,
	type BudgetWindowsContainerSeconds,
	type BudgetWindowsTokens,
	CONTAINER_HOURS_BUDGET_FIELDS,
	retiredBudgetFieldError,
	validateBudgetWindows,
	validateContainerHoursBudgetWindows,
} from '@hezo/shared';

/**
 * Each kind of budget trio as a write path checks it: its three fields, the
 * unit a value must be a whole number of, and the cross-window rules from
 * `@hezo/shared`. One table, so a token write and an hours write are refused by
 * the same steps in the same words.
 */
interface TrioRules<T> {
	fields: readonly (keyof T & string)[];
	unit: string;
	violations: (trio: T) => readonly { message: string }[];
}

const TOKEN_RULES: TrioRules<BudgetWindowsTokens> = {
	fields: BUDGET_WINDOW_FIELDS,
	unit: 'tokens',
	violations: validateBudgetWindows,
};

const CONTAINER_HOURS_RULES: TrioRules<BudgetWindowsContainerSeconds> = {
	fields: CONTAINER_HOURS_BUDGET_FIELDS,
	unit: 'seconds',
	violations: validateContainerHoursBudgetWindows,
};

function trioError<T>(rules: TrioRules<T>, w: T): string | null {
	for (const field of rules.fields) {
		const value = w[field];
		if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
			return `${field} must be a whole number of ${rules.unit} ≥ 0`;
		}
	}
	const violations = rules.violations(w);
	return violations.length > 0 ? violations[0].message : null;
}

/**
 * The trio a write leaves - each window the body supplies, else `base`'s - and
 * whether the body supplied any. `base` is the stored trio, or a new entity's
 * defaults.
 */
function mergeTrio<T>(
	rules: TrioRules<T>,
	body: Partial<Record<string, unknown>>,
	base: T,
): { merged: T; supplied: boolean } {
	const merged = { ...base };
	let supplied = false;
	for (const field of rules.fields) {
		const value = body[field];
		if (value !== undefined) {
			merged[field] = value as T[typeof field];
			supplied = true;
		}
	}
	return { merged, supplied };
}

/**
 * Validate a budget trio destined for a `member_agents`/`projects` row. Enforces
 * non-negative whole tokens per window plus the cross-window consistency rules
 * (the rules themselves live in `@hezo/shared`, shared with the web forms).
 * Returns the first problem's message, or null when the trio is coherent -
 * callers map a non-null result to a 400.
 */
export function budgetWindowsError(w: BudgetWindowsTokens): string | null {
	return trioError(TOKEN_RULES, w);
}

/**
 * The refusal for a request body that still sends a dollar budget field, or null.
 * Re-exported here so every write path reads it beside the window check.
 */
export { retiredBudgetFieldError };

/**
 * The refusal for a write that may carry a budget, or null - the one check every
 * budget write runs, whatever it writes to. A retired dollar field in the raw
 * body is refused by name, since ignoring it would store no budget at all. When
 * the body supplies any window, the trio it leaves - each supplied window, else
 * `base`'s (the stored trio, or a new entity's defaults) - must be whole,
 * non-negative and coherent.
 */
export function budgetWriteError(
	body: Partial<Record<string, unknown>>,
	base: BudgetWindowsTokens,
): string | null {
	const retired = retiredBudgetFieldError(body);
	if (retired) return retired;
	const { merged, supplied } = mergeTrio(TOKEN_RULES, body, base);
	return supplied ? trioError(TOKEN_RULES, merged) : null;
}

/**
 * The same check for a project's hours budget: the trio a write leaves, merged
 * over the stored one, whole container-seconds, non-negative and coherent under
 * the token budget's floors. Returns the merged trio when it is sound, so the
 * route writes exactly what was checked.
 */
export function containerHoursBudgetWrite(
	body: Partial<Record<string, unknown>>,
	base: BudgetWindowsContainerSeconds,
): { error: string } | { trio: BudgetWindowsContainerSeconds; supplied: boolean } {
	const { merged, supplied } = mergeTrio(CONTAINER_HOURS_RULES, body, base);
	const error = trioError(CONTAINER_HOURS_RULES, merged);
	return error ? { error } : { trio: merged, supplied };
}
