import {
	type BudgetWindows,
	type BudgetWindowsContainerSeconds,
	type BudgetWindowsTokens,
	containerSecondsToHours,
	minMonthlyLimit,
	minWeeklyLimit,
	normalizeWindowsUp,
	SECONDS_PER_HOUR,
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
	return fromTypedUnits(input, TOKENS_PER_UNIT);
}

/** A typed number of some unit -> whole base units. Empty, negative or not a number -> 0. */
function fromTypedUnits(input: string, perUnit: number): number {
	const parsed = Number.parseFloat(input || '0');
	if (!Number.isFinite(parsed)) return 0;
	return Math.max(0, Math.round(parsed * perUnit));
}

/** A typed hours string -> whole container-seconds. Empty, negative or not a number -> 0. */
export function hoursToSeconds(input: string): number {
	return fromTypedUnits(input, SECONDS_PER_HOUR);
}

/**
 * What the editor counts in, and how a person types it: the base unit the
 * server stores, the unit a person reads, and the words for both. One row per
 * kind of budget, so the auto-raise and the floors are one piece of code.
 */
interface EditorUnit {
	/** Base units (tokens, seconds) -> the number an input shows. */
	toDisplay: (base: number) => number;
	/** A typed string -> base units. */
	fromInput: (input: string) => number;
	step: string;
	unitLabel: MessageKey;
	inputLabel: MessageKey;
	minimumFromDaily: MessageKey;
	minimumFromShorter: MessageKey;
	/** Prefix for each window's test id, so two editors on one page stay apart. */
	testIdPrefix: string;
}

const TOKEN_UNIT: EditorUnit = {
	toDisplay: tokensInMillions,
	fromInput: millionsToTokens,
	step: '0.1',
	unitLabel: 'budget.window.unit',
	inputLabel: 'budget.window.input',
	minimumFromDaily: 'budget.window.minimumFromDaily',
	minimumFromShorter: 'budget.window.minimumFromShorter',
	testIdPrefix: 'budget',
};

const HOURS_UNIT: EditorUnit = {
	toDisplay: containerSecondsToHours,
	fromInput: hoursToSeconds,
	step: '0.25',
	unitLabel: 'budget.window.unitHours',
	inputLabel: 'budget.window.inputHours',
	minimumFromDaily: 'budget.window.minimumHoursFromDaily',
	minimumFromShorter: 'budget.window.minimumHoursFromShorter',
	testIdPrefix: 'hours-budget',
};

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

/**
 * The daily/weekly/monthly budget-editing UX, in any unit - a per-window enable
 * toggle, an input, a live "minimum" hint, and the cross-window auto-raise.
 * Editing a shorter window silently raises the dependent longer windows to their
 * floor; a longer window typed below its floor is clamped up on blur. Because the
 * editor only ever emits a coherent trio (via `normalizeWindowsUp`), parents
 * just store `value` and submit it. 0 = unlimited/disabled.
 */
function WindowsEditor({
	unit,
	value,
	onChange,
	className = '',
}: {
	unit: EditorUnit;
	value: BudgetWindows;
	onChange: (next: BudgetWindows) => void;
	className?: string;
}) {
	const { t, formatNumber } = useI18n();
	const toInput = (base: number) => String(unit.toDisplay(base));
	const seed = (v: BudgetWindows): FieldState => ({
		daily: toInput(v.daily),
		weekly: toInput(v.weekly),
		monthly: toInput(v.monthly),
		dailyEnabled: v.daily > 0,
		weeklyEnabled: v.weekly > 0,
		monthlyEnabled: v.monthly > 0,
	});
	const toBase = (f: FieldState): BudgetWindows => ({
		daily: f.dailyEnabled ? unit.fromInput(f.daily) : 0,
		weekly: f.weeklyEnabled ? unit.fromInput(f.weekly) : 0,
		monthly: f.monthlyEnabled ? unit.fromInput(f.monthly) : 0,
	});

	const [fields, setFields] = useState<FieldState>(() => seed(value));
	// Last value we emitted, so an echoed-back `value` prop doesn't clobber edits.
	const lastEmitted = useRef<BudgetWindows>(value);
	// Last non-zero input per window, to restore on re-enable.
	const lastNonZero = useRef<Record<WindowKey, string>>({
		daily: value.daily > 0 ? toInput(value.daily) : '',
		weekly: value.weekly > 0 ? toInput(value.weekly) : '',
		monthly: value.monthly > 0 ? toInput(value.monthly) : '',
	});

	// Re-seed when the parent pushes a value we didn't emit (e.g. the entity loaded
	// after first render). An echo of our own last emit is ignored.
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the three numbers, not on the object a wrapper rebuilds every render
	useEffect(() => {
		const e = lastEmitted.current;
		if (e.daily === value.daily && e.weekly === value.weekly && e.monthly === value.monthly) {
			return;
		}
		lastEmitted.current = value;
		setFields(seed(value));
	}, [value.daily, value.weekly, value.monthly]);

	function commit(next: FieldState, norm: BudgetWindows) {
		// Reflect any auto-raised window back into its input string.
		const typed = toBase(next);
		const reflected: FieldState = {
			...next,
			weekly:
				next.weeklyEnabled && norm.weekly !== typed.weekly ? toInput(norm.weekly) : next.weekly,
			monthly:
				next.monthlyEnabled && norm.monthly !== typed.monthly
					? toInput(norm.monthly)
					: next.monthly,
		};
		for (const key of ['daily', 'weekly', 'monthly'] as const) {
			if (reflected[`${key}Enabled`] && unit.fromInput(reflected[key]) > 0) {
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
		const base = toBase(next);
		let weekly = base.weekly;
		if (edited === 'daily' && next.weeklyEnabled) {
			weekly = Math.max(weekly, minWeeklyLimit(base.daily));
		}
		let monthly = base.monthly;
		if (edited !== 'monthly' && next.monthlyEnabled) {
			monthly = Math.max(monthly, minMonthlyLimit(base.daily, weekly));
		}
		commit(next, { daily: base.daily, weekly, monthly });
	}

	// On blur, clamp everything up — including a longer window the user just typed
	// below its floor.
	function handleBlur() {
		commit(fields, normalizeWindowsUp(toBase(fields)));
	}

	function handleToggle(key: WindowKey, enabled: boolean) {
		const next: FieldState = { ...fields, [`${key}Enabled`]: enabled };
		if (enabled) {
			const restored = lastNonZero.current[key];
			next[key] = restored && unit.fromInput(restored) > 0 ? restored : '0';
		}
		// Toggling isn't typing, so a full clamp is fine here.
		commit(next, normalizeWindowsUp(toBase(next)));
	}

	const base = toBase(fields);
	const weeklyFloor = minWeeklyLimit(base.daily);
	const monthlyFloor = minMonthlyLimit(base.daily, base.weekly);

	const rows: { key: WindowKey; enabled: boolean; inputVal: string; floor: number }[] = [
		{ key: 'daily', enabled: fields.dailyEnabled, inputVal: fields.daily, floor: 0 },
		{ key: 'weekly', enabled: fields.weeklyEnabled, inputVal: fields.weekly, floor: weeklyFloor },
		{
			key: 'monthly',
			enabled: fields.monthlyEnabled,
			inputVal: fields.monthly,
			floor: monthlyFloor,
		},
	];

	return (
		<div className={`grid grid-cols-1 gap-4 sm:grid-cols-3 ${className}`}>
			{rows.map((row) => {
				const window = t(WINDOW_LABEL[row.key]);
				const testid = `${unit.testIdPrefix}-${row.key}`;
				return (
					<div key={row.key} className="flex flex-col gap-1.5">
						<label className="flex items-center gap-2 cursor-pointer">
							<input
								type="checkbox"
								checked={row.enabled}
								onChange={(e) => handleToggle(row.key, e.target.checked)}
								data-testid={`${testid}-toggle`}
								aria-label={t('budget.window.enable', { window })}
							/>
							<span className="text-xs font-medium uppercase tracking-wider text-text-2">
								{t(unit.unitLabel, { window })}
							</span>
						</label>
						{row.enabled ? (
							<>
								<Input
									type="number"
									step={unit.step}
									min={row.floor > 0 ? toInput(row.floor) : '0'}
									value={row.inputVal}
									onChange={(e) => handleChange(row.key, e.target.value)}
									onBlur={handleBlur}
									data-testid={testid}
									aria-label={t(unit.inputLabel, { window })}
								/>
								{row.floor > 0 && (
									<span className="text-xs text-text-3" data-testid={`${testid}-hint`}>
										{t(row.key === 'weekly' ? unit.minimumFromDaily : unit.minimumFromShorter, {
											amount: formatNumber(unit.toDisplay(row.floor)),
										})}
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

/**
 * A token budget's three windows, in millions of tokens.
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
	return (
		<WindowsEditor
			unit={TOKEN_UNIT}
			value={{
				daily: value.daily_budget_tokens,
				weekly: value.weekly_budget_tokens,
				monthly: value.monthly_budget_tokens,
			}}
			onChange={(next) =>
				onChange({
					daily_budget_tokens: next.daily,
					weekly_budget_tokens: next.weekly,
					monthly_budget_tokens: next.monthly,
				})
			}
			className={className}
		/>
	);
}

/** A project's hours budget's three windows, typed in hours and stored in container-seconds. */
export function ContainerHoursBudgetEditor({
	value,
	onChange,
	className = '',
}: {
	value: BudgetWindowsContainerSeconds;
	onChange: (next: BudgetWindowsContainerSeconds) => void;
	className?: string;
}) {
	return (
		<WindowsEditor
			unit={HOURS_UNIT}
			value={{
				daily: value.daily_budget_container_seconds,
				weekly: value.weekly_budget_container_seconds,
				monthly: value.monthly_budget_container_seconds,
			}}
			onChange={(next) =>
				onChange({
					daily_budget_container_seconds: next.daily,
					weekly_budget_container_seconds: next.weekly,
					monthly_budget_container_seconds: next.monthly,
				})
			}
			className={className}
		/>
	);
}
