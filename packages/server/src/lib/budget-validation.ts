import { type BudgetWindowsCents, validateBudgetWindows } from '@hezo/shared';

/**
 * Validate a budget trio destined for a `member_agents`/`projects` row. Enforces
 * non-negative integer cents per window plus the cross-window consistency rules
 * (the rules themselves live in `@hezo/shared`, shared with the web forms).
 * Returns the first problem's message, or null when the trio is coherent —
 * callers map a non-null result to a 400.
 */
export function budgetWindowsError(w: BudgetWindowsCents): string | null {
	for (const field of [
		'daily_budget_cents',
		'weekly_budget_cents',
		'monthly_budget_cents',
	] as const) {
		const value = w[field];
		if (!Number.isInteger(value) || value < 0) {
			return `${field} must be an integer ≥ 0`;
		}
	}
	const violations = validateBudgetWindows(w);
	return violations.length > 0 ? violations[0].message : null;
}
