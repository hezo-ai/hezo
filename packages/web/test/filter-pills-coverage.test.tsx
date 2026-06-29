import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test } from 'vitest';
import { FilterPills } from '../src/components/ui/filter-pills';

// Component tier (happy-dom). FilterPills is a pure presentational primitive
// with no router/query deps, so it renders directly. Covers the active vs
// inactive branch, the count-present vs count-absent branch (including count
// === 0, which `!= null` must still render), the optional badge slot, and the
// onChange callback wiring.

test('renders one button per option and fires onChange with the clicked value', async () => {
	const user = userEvent.setup({ delay: null });
	const seen: string[] = [];
	const { getByRole } = render(
		<FilterPills<'all' | 'unread'>
			options={[
				{ value: 'all', label: 'All' },
				{ value: 'unread', label: 'Unread' },
			]}
			value="all"
			onChange={(v) => seen.push(v)}
		/>,
	);

	await user.click(getByRole('button', { name: 'Unread' }));
	expect(seen).toEqual(['unread']);
});

test('applies the active styling only to the selected option', () => {
	const { getByRole } = render(
		<FilterPills<'a' | 'b'>
			options={[
				{ value: 'a', label: 'Alpha' },
				{ value: 'b', label: 'Beta' },
			]}
			value="b"
			onChange={() => {}}
		/>,
	);

	const active = getByRole('button', { name: 'Beta' });
	const inactive = getByRole('button', { name: 'Alpha' });
	expect(active.className).toContain('bg-inverse');
	expect(inactive.className).not.toContain('bg-inverse');
	expect(inactive.className).toContain('text-text-2');
});

test('renders a count (including zero) but omits it when undefined', () => {
	const { getByRole } = render(
		<FilterPills<'with' | 'zero' | 'none'>
			options={[
				{ value: 'with', label: 'With', count: 7 },
				{ value: 'zero', label: 'Zero', count: 0 },
				{ value: 'none', label: 'None' },
			]}
			value="with"
			onChange={() => {}}
		/>,
	);

	// Count present → the number renders inside the button.
	expect(getByRole('button', { name: 'With 7' }).textContent).toContain('7');
	// Count === 0 still renders (the guard is `!= null`, not truthiness).
	expect(getByRole('button', { name: 'Zero 0' }).textContent).toContain('0');
	// No count → just the label, no extra mono span.
	const none = getByRole('button', { name: 'None' });
	expect(none.querySelector('span.font-mono')).toBeNull();
});

test('renders the optional badge node', () => {
	const { getByRole, getByTestId } = render(
		<FilterPills<'x'>
			options={[
				{
					value: 'x',
					label: 'Mentions',
					badge: <span data-testid="pill-badge">NEW</span>,
				},
			]}
			value="x"
			onChange={() => {}}
		/>,
	);

	expect(getByTestId('pill-badge')).toBeTruthy();
	expect(getByRole('button', { name: /Mentions/ }).textContent).toContain('NEW');
});
