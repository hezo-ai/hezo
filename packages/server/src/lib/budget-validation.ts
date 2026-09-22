import {
	BUDGET_WINDOW_FIELDS,
	type BudgetWindowsTokens,
	retiredBudgetFieldError,
	validateBudgetWindows,
} from '@hezo/shared';

/**
 * Validate a budget trio destined for a `member_agents`/`projects` row. Enforces
 * non-negative whole tokens per window plus the cross-window consistency rules
 * (the rules themselves live in `@hezo/shared`, shared with the web forms).
 * Returns the first problem's message, or null when the trio is coherent -
 * callers map a non-null result to a 400.
 */
export function budgetWindowsError(w: BudgetWindowsTokens): string | null {
	for (const field of BUDGET_WINDOW_FIELDS) {
		const value = w[field];
		if (!Number.isSafeInteger(value) || value < 0) {
			return `${field} must be a whole number of tokens ≥ 0`;
		}
	}
	const violations = validateBudgetWindows(w);
	return violations.length > 0 ? violations[0].message : null;
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
	if (!BUDGET_WINDOW_FIELDS.some((field) => body[field] !== undefined)) return null;
	const merged = { ...base };
	for (const field of BUDGET_WINDOW_FIELDS) {
		const value = body[field];
		if (value !== undefined) merged[field] = value as number;
	}
	return budgetWindowsError(merged);
}
