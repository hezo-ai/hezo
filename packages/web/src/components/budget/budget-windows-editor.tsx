import {
	type BudgetWindowsTokens,
	minMonthlyTokens,
	minWeeklyTokens,
	normalizeBudgetWindowsUp,
} from '@hezo/shared';
import { useEffect, useRef, useState } from 'react';
import { type MessageKey, useI18n } from '../../lib/i18n';
import { Input } from '../ui/input';

/** Budgets are typed in millions of tokens: a raw token count is too long to read. */
const TOKENS_PER_UNIT = 1_000_000;

/** Tokens as millions, e.g. 20500000 -> 20.5, for text a number format punctuates. */
export function tokensInMillions(tokens: number): number {
	return Math.round((tokens / TOKENS_PER_UNIT) * 1000) / 1000;
}

/** Tokens -> the millions string an input shows, always machine-punctuated. */
export function tokensToMillions(tokens: number): string {
	return String(tokensInMillions(tokens));
}

/** A typed millions string -> whole tokens. Empty, negative or not a number -> 0. */
export function millionsToTokens(input: string): number {
	const parsed = Number.parseFloat(input || '0');
	if (!Number.isFinite(parsed)) return 0;
	return Math.max(0, Math.round(parsed * TOKENS_PER_UNIT));
}

const WINDOW_LABEL: Record<'daily' | 'weekly' | 'monthly', MessageKey> = {
	daily: 'budget.window.daily',
	weekly: 'budget.window.weekly',
	monthly: 'budget.window.monthly',
};

type WindowKey = 'daily' | 'weekly' | 'monthly';

interface FieldState {
	daily: string;
	weekly: string;
	monthly: string;
	dailyEnabled: boolean;
	weeklyEnabled: boolean;
	monthlyEnabled: boolean;
}

function seed(value: BudgetWindowsTokens): FieldState {
	return {
		daily: tokensToMillions(value.daily_budget_tokens),
		weekly: tokensToMillions(value.weekly_budget_tokens),
		monthly: tokensToMillions(value.monthly_budget_tokens),
		dailyEnabled: value.daily_budget_tokens > 0,
		weeklyEnabled: value.weekly_budget_tokens > 0,
		monthlyEnabled: value.monthly_budget_tokens > 0,
	};
}

function toTokens(f: FieldState): BudgetWindowsTokens {
	return {
		daily_budget_tokens: f.dailyEnabled ? millionsToTokens(f.daily) : 0,
		weekly_budget_tokens: f.weeklyEnabled ? millionsToTokens(f.weekly) : 0,
		monthly_budget_tokens: f.monthlyEnabled ? millionsToTokens(f.monthly) : 0,
	};
}

/**
 * The single place the daily/weekly/monthly budget-editing UX lives - a per-window
 * enable toggle, an input in millions of tokens, a live "minimum" hint, and the
 * cross-window auto-raise.
 * Editing a shorter window silently raises the dependent longer windows to their
 * floor; a longer window typed below its floor is clamped up on blur. Because the
 * editor only ever emits a coherent trio (via `normalizeBudgetWindowsUp`), parents
 * just store `value` and submit it. 0 = unlimited/disabled.
 *
 * Used by the project budget form, the agent settings form, and the hire form so the
 * rules (in `@hezo/shared`) are never re-implemented per form.
 */
export function BudgetWindowsEditor({
	value,
	onChange,
	className = '',
}: {
	value: BudgetWindowsTokens;
	onChange: (next: BudgetWindowsTokens) => void;
	className?: string;
}) {
	const { t, formatNumber } = useI18n();
	const [fields, setFields] = useState<FieldState>(() => seed(value));
	// Last value we emitted, so an echoed-back `value` prop doesn't clobber edits.
	const lastEmitted = useRef<BudgetWindowsTokens>(value);
	// Last non-zero input per window, to restore on re-enable.
	const lastNonZero = useRef<Record<WindowKey, string>>({
		daily: value.daily_budget_tokens > 0 ? tokensToMillions(value.daily_budget_tokens) : '',
		weekly: value.weekly_budget_tokens > 0 ? tokensToMillions(value.weekly_budget_tokens) : '',
		monthly: value.monthly_budget_tokens > 0 ? tokensToMillions(value.monthly_budget_tokens) : '',
	});

	// Re-seed when the parent pushes a value we didn't emit (e.g. the entity loaded
	// after first render). An echo of our own last emit is ignored.
	useEffect(() => {
		const e = lastEmitted.current;
		if (
			e.daily_budget_tokens === value.daily_budget_tokens &&
			e.weekly_budget_tokens === value.weekly_budget_tokens &&
			e.monthly_budget_tokens === value.monthly_budget_tokens
		) {
			return;
		}
		lastEmitted.current = value;
		setFields(seed(value));
	}, [value]);

	function commit(next: FieldState, norm: BudgetWindowsTokens) {
		// Reflect any auto-raised window back into its input string.
		const reflected: FieldState = {
			...next,
			weekly:
				next.weeklyEnabled && norm.weekly_budget_tokens !== toTokens(next).weekly_budget_tokens
					? tokensToMillions(norm.weekly_budget_tokens)
					: next.weekly,
			monthly:
				next.monthlyEnabled && norm.monthly_budget_tokens !== toTokens(next).monthly_budget_tokens
					? tokensToMillions(norm.monthly_budget_tokens)
					: next.monthly,
		};
		for (const key of ['daily', 'weekly', 'monthly'] as const) {
			if (reflected[`${key}Enabled`] && millionsToTokens(reflected[key]) > 0) {
				lastNonZero.current[key] = reflected[key];
			}
		}
		setFields(reflected);
		lastEmitted.current = norm;
		onChange(norm);
	}

	// On change of `edited`, raise only windows *strictly longer* than it — never the
	// field being typed into (clamping that mid-keystroke would fight the user).
	function handleChange(edited: WindowKey, str: string) {
		const next = { ...fields, [edited]: str };
		const tokens = toTokens(next);
		let weekly = tokens.weekly_budget_tokens;
		if (edited === 'daily' && next.weeklyEnabled) {
			weekly = Math.max(weekly, minWeeklyTokens(tokens.daily_budget_tokens));
		}
		let monthly = tokens.monthly_budget_tokens;
		if (edited !== 'monthly' && next.monthlyEnabled) {
			monthly = Math.max(monthly, minMonthlyTokens(tokens.daily_budget_tokens, weekly));
		}
		commit(next, {
			daily_budget_tokens: tokens.daily_budget_tokens,
			weekly_budget_tokens: weekly,
			monthly_budget_tokens: monthly,
		});
	}

	// On blur, clamp everything up — including a longer window the user just typed
	// below its floor.
	function handleBlur() {
		commit(fields, normalizeBudgetWindowsUp(toTokens(fields)));
	}

	function handleToggle(key: WindowKey, enabled: boolean) {
		const next: FieldState = { ...fields, [`${key}Enabled`]: enabled };
		if (enabled) {
			const restored = lastNonZero.current[key];
			next[key] = restored && millionsToTokens(restored) > 0 ? restored : '0';
		}
		// Toggling isn't typing, so a full clamp is fine here.
		commit(next, normalizeBudgetWindowsUp(toTokens(next)));
	}

	const tokens = toTokens(fields);
	const weeklyFloor = minWeeklyTokens(tokens.daily_budget_tokens);
	const monthlyFloor = minMonthlyTokens(tokens.daily_budget_tokens, tokens.weekly_budget_tokens);

	const rows: {
		key: WindowKey;
		enabled: boolean;
		inputVal: string;
		floor: number;
		testid: string;
	}[] = [
		{
			key: 'daily',
			enabled: fields.dailyEnabled,
			inputVal: fields.daily,
			floor: 0,
			testid: 'budget-daily',
		},
		{
			key: 'weekly',
			enabled: fields.weeklyEnabled,
			inputVal: fields.weekly,
			floor: weeklyFloor,
			testid: 'budget-weekly',
		},
		{
			key: 'monthly',
			enabled: fields.monthlyEnabled,
			inputVal: fields.monthly,
			floor: monthlyFloor,
			testid: 'budget-monthly',
		},
	];

	return (
		<div className={`grid grid-cols-1 gap-4 sm:grid-cols-3 ${className}`}>
			{rows.map((row) => {
				const window = t(WINDOW_LABEL[row.key]);
				return (
					<div key={row.key} className="flex flex-col gap-1.5">
						<label className="flex items-center gap-2 cursor-pointer">
							<input
								type="checkbox"
								checked={row.enabled}
								onChange={(e) => handleToggle(row.key, e.target.checked)}
								data-testid={`${row.testid}-toggle`}
								aria-label={t('budget.window.enable', { window })}
							/>
							<span className="text-xs font-medium uppercase tracking-wider text-text-2">
								{t('budget.window.unit', { window })}
							</span>
						</label>
						{row.enabled ? (
							<>
								<Input
									type="number"
									step="0.1"
									min={row.floor > 0 ? tokensToMillions(row.floor) : '0'}
									value={row.inputVal}
									onChange={(e) => handleChange(row.key, e.target.value)}
									onBlur={handleBlur}
									data-testid={row.testid}
									aria-label={t('budget.window.input', { window })}
								/>
								{row.floor > 0 && (
									<span className="text-xs text-text-3" data-testid={`${row.testid}-hint`}>
										{t(
											row.key === 'weekly'
												? 'budget.window.minimumFromDaily'
												: 'budget.window.minimumFromShorter',
											{ amount: formatNumber(tokensInMillions(row.floor)) },
										)}
									</span>
								)}
							</>
						) : (
							<span className="text-[13px] text-text-3 py-2">{t('budget.window.unlimited')}</span>
						)}
					</div>
				);
			})}
		</div>
	);
}
