import {
	type BudgetWindowsCents,
	centsToDollars,
	dollarsToCents,
	minMonthlyCents,
	minWeeklyCents,
	normalizeBudgetWindowsUp,
} from '@hezo/shared';
import { useEffect, useRef, useState } from 'react';
import { Input } from '../ui/input';

type WindowKey = 'daily' | 'weekly' | 'monthly';

interface FieldState {
	daily: string;
	weekly: string;
	monthly: string;
	dailyEnabled: boolean;
	weeklyEnabled: boolean;
	monthlyEnabled: boolean;
}

function seed(value: BudgetWindowsCents): FieldState {
	return {
		daily: centsToDollars(value.daily_budget_cents),
		weekly: centsToDollars(value.weekly_budget_cents),
		monthly: centsToDollars(value.monthly_budget_cents),
		dailyEnabled: value.daily_budget_cents > 0,
		weeklyEnabled: value.weekly_budget_cents > 0,
		monthlyEnabled: value.monthly_budget_cents > 0,
	};
}

function toCents(f: FieldState): BudgetWindowsCents {
	return {
		daily_budget_cents: f.dailyEnabled ? dollarsToCents(f.daily) : 0,
		weekly_budget_cents: f.weeklyEnabled ? dollarsToCents(f.weekly) : 0,
		monthly_budget_cents: f.monthlyEnabled ? dollarsToCents(f.monthly) : 0,
	};
}

/**
 * The single place the daily/weekly/monthly budget-editing UX lives — a per-window
 * enable toggle, a `$` input, a live "minimum" hint, and the cross-window auto-raise.
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
	value: BudgetWindowsCents;
	onChange: (next: BudgetWindowsCents) => void;
	className?: string;
}) {
	const [fields, setFields] = useState<FieldState>(() => seed(value));
	// Last value we emitted, so an echoed-back `value` prop doesn't clobber edits.
	const lastEmitted = useRef<BudgetWindowsCents>(value);
	// Last non-zero dollar string per window, to restore on re-enable.
	const lastNonZero = useRef<Record<WindowKey, string>>({
		daily: value.daily_budget_cents > 0 ? centsToDollars(value.daily_budget_cents) : '',
		weekly: value.weekly_budget_cents > 0 ? centsToDollars(value.weekly_budget_cents) : '',
		monthly: value.monthly_budget_cents > 0 ? centsToDollars(value.monthly_budget_cents) : '',
	});

	// Re-seed when the parent pushes a value we didn't emit (e.g. the entity loaded
	// after first render). An echo of our own last emit is ignored.
	useEffect(() => {
		const e = lastEmitted.current;
		if (
			e.daily_budget_cents === value.daily_budget_cents &&
			e.weekly_budget_cents === value.weekly_budget_cents &&
			e.monthly_budget_cents === value.monthly_budget_cents
		) {
			return;
		}
		lastEmitted.current = value;
		setFields(seed(value));
	}, [value]);

	function commit(next: FieldState, norm: BudgetWindowsCents) {
		// Reflect any auto-raised window back into its dollar string.
		const reflected: FieldState = {
			...next,
			weekly:
				next.weeklyEnabled && norm.weekly_budget_cents !== toCents(next).weekly_budget_cents
					? centsToDollars(norm.weekly_budget_cents)
					: next.weekly,
			monthly:
				next.monthlyEnabled && norm.monthly_budget_cents !== toCents(next).monthly_budget_cents
					? centsToDollars(norm.monthly_budget_cents)
					: next.monthly,
		};
		for (const key of ['daily', 'weekly', 'monthly'] as const) {
			if (reflected[`${key}Enabled`] && dollarsToCents(reflected[key]) > 0) {
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
		const cents = toCents(next);
		let weekly = cents.weekly_budget_cents;
		if (edited === 'daily' && next.weeklyEnabled) {
			weekly = Math.max(weekly, minWeeklyCents(cents.daily_budget_cents));
		}
		let monthly = cents.monthly_budget_cents;
		if (edited !== 'monthly' && next.monthlyEnabled) {
			monthly = Math.max(monthly, minMonthlyCents(cents.daily_budget_cents, weekly));
		}
		commit(next, {
			daily_budget_cents: cents.daily_budget_cents,
			weekly_budget_cents: weekly,
			monthly_budget_cents: monthly,
		});
	}

	// On blur, clamp everything up — including a longer window the user just typed
	// below its floor.
	function handleBlur() {
		commit(fields, normalizeBudgetWindowsUp(toCents(fields)));
	}

	function handleToggle(key: WindowKey, enabled: boolean) {
		const next: FieldState = { ...fields, [`${key}Enabled`]: enabled };
		if (enabled) {
			const restored = lastNonZero.current[key];
			next[key] = restored && dollarsToCents(restored) > 0 ? restored : centsToDollars(0);
		}
		// Toggling isn't typing, so a full clamp is fine here.
		commit(next, normalizeBudgetWindowsUp(toCents(next)));
	}

	const cents = toCents(fields);
	const weeklyFloor = minWeeklyCents(cents.daily_budget_cents);
	const monthlyFloor = minMonthlyCents(cents.daily_budget_cents, cents.weekly_budget_cents);

	const rows: {
		key: WindowKey;
		label: string;
		enabled: boolean;
		dollarVal: string;
		floor: number;
		testid: string;
	}[] = [
		{
			key: 'daily',
			label: 'Daily',
			enabled: fields.dailyEnabled,
			dollarVal: fields.daily,
			floor: 0,
			testid: 'budget-daily',
		},
		{
			key: 'weekly',
			label: 'Weekly',
			enabled: fields.weeklyEnabled,
			dollarVal: fields.weekly,
			floor: weeklyFloor,
			testid: 'budget-weekly',
		},
		{
			key: 'monthly',
			label: 'Monthly',
			enabled: fields.monthlyEnabled,
			dollarVal: fields.monthly,
			floor: monthlyFloor,
			testid: 'budget-monthly',
		},
	];

	return (
		<div className={`grid grid-cols-1 gap-4 sm:grid-cols-3 ${className}`}>
			{rows.map((row) => (
				<div key={row.key} className="flex flex-col gap-1.5">
					<label className="flex items-center gap-2 cursor-pointer">
						<input
							type="checkbox"
							checked={row.enabled}
							onChange={(e) => handleToggle(row.key, e.target.checked)}
							data-testid={`${row.testid}-toggle`}
							aria-label={`Enable ${row.label.toLowerCase()} budget`}
						/>
						<span className="text-xs font-medium uppercase tracking-wider text-text-muted">
							{row.label} ($)
						</span>
					</label>
					{row.enabled ? (
						<>
							<Input
								type="number"
								step="0.01"
								min={row.floor > 0 ? centsToDollars(row.floor) : '0'}
								value={row.dollarVal}
								onChange={(e) => handleChange(row.key, e.target.value)}
								onBlur={handleBlur}
								data-testid={row.testid}
								aria-label={`${row.label} budget`}
							/>
							{row.floor > 0 && (
								<span className="text-xs text-text-subtle" data-testid={`${row.testid}-hint`}>
									Minimum ${centsToDollars(row.floor)} based on the{' '}
									{row.key === 'weekly' ? 'daily' : 'shorter'} budget
								</span>
							)}
						</>
					) : (
						<span className="text-[13px] text-text-subtle py-2">Unlimited</span>
					)}
				</div>
			))}
		</div>
	);
}
