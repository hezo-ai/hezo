import type { BudgetWindowsCents } from '@hezo/shared';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { expect, test, vi } from 'vitest';
import { BudgetWindowsEditor } from '../src/components/budget/budget-windows-editor';

/** Controlled wrapper mirroring how the real forms drive the editor. */
function Harness({
	initial,
	onChange,
}: {
	initial: BudgetWindowsCents;
	onChange: (next: BudgetWindowsCents) => void;
}) {
	const [value, setValue] = useState(initial);
	return (
		<BudgetWindowsEditor
			value={value}
			onChange={(next) => {
				setValue(next);
				onChange(next);
			}}
		/>
	);
}

test('auto-raises the longer windows when the daily budget is edited', async () => {
	const user = userEvent.setup();
	const onChange = vi.fn();
	// All three windows enabled (non-zero) so the longer ones can be auto-raised.
	const { getByTestId } = render(
		<Harness
			initial={{ daily_budget_cents: 100, weekly_budget_cents: 100, monthly_budget_cents: 100 }}
			onChange={onChange}
		/>,
	);

	const daily = getByTestId('budget-daily') as HTMLInputElement;
	await user.clear(daily);
	await user.type(daily, '20'); // $20/day

	// daily × 7 = $140 weekly floor; ceil(2000 × 365/12) = 60834¢ monthly floor.
	const last = onChange.mock.calls.at(-1)?.[0] as BudgetWindowsCents;
	expect(last).toEqual({
		daily_budget_cents: 2000,
		weekly_budget_cents: 14000,
		monthly_budget_cents: 60834,
	});
	// The raised values are reflected back into the inputs.
	expect((getByTestId('budget-weekly') as HTMLInputElement).value).toBe('140.00');
	expect((getByTestId('budget-monthly') as HTMLInputElement).value).toBe('608.34');
});

test('disabling a window emits 0 (unlimited) and drops its constraint', async () => {
	const user = userEvent.setup();
	const onChange = vi.fn();
	const { getByTestId, queryByTestId } = render(
		<Harness
			initial={{
				daily_budget_cents: 2000,
				weekly_budget_cents: 14000,
				monthly_budget_cents: 60834,
			}}
			onChange={onChange}
		/>,
	);

	await user.click(getByTestId('budget-weekly-toggle'));

	const last = onChange.mock.calls.at(-1)?.[0] as BudgetWindowsCents;
	expect(last.weekly_budget_cents).toBe(0);
	// The weekly input disappears (replaced by an "Unlimited" placeholder).
	expect(queryByTestId('budget-weekly')).toBeNull();
});

test('renders a live minimum hint for a constrained window', async () => {
	const onChange = vi.fn();
	const { getByTestId } = render(
		<Harness
			initial={{ daily_budget_cents: 2000, weekly_budget_cents: 14000, monthly_budget_cents: 0 }}
			onChange={onChange}
		/>,
	);
	expect(getByTestId('budget-weekly-hint').textContent).toContain('Minimum $140.00');
});
