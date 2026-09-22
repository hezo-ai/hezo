import { type BudgetWindowsTokens, DEFAULT_LOCALE_SETTINGS, NumberFormat } from '@hezo/shared';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { expect, test, vi } from 'vitest';
import {
	BudgetWindowsEditor,
	millionsToTokens,
	tokensToMillions,
} from '../src/components/budget/budget-windows-editor';
import { I18nProvider } from '../src/lib/i18n';

/** Controlled wrapper mirroring how the real forms drive the editor. */
function Harness({
	initial,
	onChange,
}: {
	initial: BudgetWindowsTokens;
	onChange: (next: BudgetWindowsTokens) => void;
}) {
	const [value, setValue] = useState(initial);
	return (
		<I18nProvider>
			<BudgetWindowsEditor
				value={value}
				onChange={(next) => {
					setValue(next);
					onChange(next);
				}}
			/>
		</I18nProvider>
	);
}

test('auto-raises the longer windows when the daily budget is edited', async () => {
	const user = userEvent.setup();
	const onChange = vi.fn();
	// All three windows enabled (non-zero) so the longer ones can be auto-raised.
	const { getByTestId } = render(
		<Harness
			initial={{
				daily_budget_tokens: 1_000_000,
				weekly_budget_tokens: 1_000_000,
				monthly_budget_tokens: 1_000_000,
			}}
			onChange={onChange}
		/>,
	);

	const daily = getByTestId('budget-daily') as HTMLInputElement;
	await user.clear(daily);
	await user.type(daily, '20'); // 20 million tokens a day

	// daily × 7 = 140 million weekly floor; ceil(20M × 365/12) monthly floor.
	const last = onChange.mock.calls.at(-1)?.[0] as BudgetWindowsTokens;
	expect(last).toEqual({
		daily_budget_tokens: 20_000_000,
		weekly_budget_tokens: 140_000_000,
		monthly_budget_tokens: 608_333_334,
	});
	// The raised values are reflected back into the inputs, in millions.
	expect((getByTestId('budget-weekly') as HTMLInputElement).value).toBe('140');
	expect((getByTestId('budget-monthly') as HTMLInputElement).value).toBe('608.333');
});

test('disabling a window emits 0 (unlimited) and drops its constraint', async () => {
	const user = userEvent.setup();
	const onChange = vi.fn();
	const { getByTestId, queryByTestId } = render(
		<Harness
			initial={{
				daily_budget_tokens: 20_000_000,
				weekly_budget_tokens: 140_000_000,
				monthly_budget_tokens: 608_333_334,
			}}
			onChange={onChange}
		/>,
	);

	await user.click(getByTestId('budget-weekly-toggle'));

	const last = onChange.mock.calls.at(-1)?.[0] as BudgetWindowsTokens;
	expect(last.weekly_budget_tokens).toBe(0);
	// The weekly input disappears (replaced by an "Unlimited" placeholder).
	expect(queryByTestId('budget-weekly')).toBeNull();
});

test('renders a live minimum hint for a constrained window', async () => {
	const onChange = vi.fn();
	const { getByTestId } = render(
		<Harness
			initial={{
				daily_budget_tokens: 20_000_000,
				weekly_budget_tokens: 140_000_000,
				monthly_budget_tokens: 0,
			}}
			onChange={onChange}
		/>,
	);
	expect(getByTestId('budget-weekly-hint').textContent).toContain('At least 140 million');
});

test("punctuates the minimum hint by the reader's number format", async () => {
	localStorage.setItem(
		'locale',
		JSON.stringify({ ...DEFAULT_LOCALE_SETTINGS, number_format: NumberFormat.SpaceComma }),
	);
	try {
		const { getByTestId } = render(
			<Harness
				initial={{
					daily_budget_tokens: 20_500_000,
					weekly_budget_tokens: 143_500_000,
					monthly_budget_tokens: 0,
				}}
				onChange={vi.fn()}
			/>,
		);
		expect(getByTestId('budget-weekly-hint').textContent).toContain('143,5');
	} finally {
		localStorage.removeItem('locale');
	}
});

test('converts between the millions a person types and whole tokens', () => {
	expect(millionsToTokens('2.5')).toBe(2_500_000);
	expect(millionsToTokens('')).toBe(0);
	expect(millionsToTokens('-3')).toBe(0);
	expect(millionsToTokens('abc')).toBe(0);
	expect(tokensToMillions(20_500_000)).toBe('20.5');
	expect(tokensToMillions(608_333_334)).toBe('608.333');
});
