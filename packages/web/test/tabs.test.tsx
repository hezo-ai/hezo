import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { expect, test, vi } from 'vitest';
import { Tabs } from '../src/components/ui/tabs';

const items = [
	{ key: 'all', label: 'All' },
	{ key: 'egress', label: 'Outbound', count: 3, testId: 'tab-egress' },
];

test('controlled Tabs marks the active tab with folder-tab styling and recesses the rest', () => {
	const { getByRole } = render(<Tabs items={items} value="all" onValueChange={() => {}} />);

	// Container is a tablist; tabs carry role="tab" + aria-selected.
	expect(getByRole('tablist')).toBeTruthy();
	const active = getByRole('tab', { name: 'All' });
	const inactive = getByRole('tab', { name: /Outbound/ });

	expect(active.getAttribute('aria-selected')).toBe('true');
	expect(inactive.getAttribute('aria-selected')).toBe('false');

	// Active tab is raised "in front": its fill matches the panel below (default
	// bg-bg) and its bottom border is painted that same colour with an important
	// utility (border-b-bg!) — the `!` beats the global unlayered border-color
	// reset — so it covers the strip's baseline and merges into the panel instead
	// of reading as a closed box with a bottom border.
	expect(active.className).toMatch(/bg-bg/);
	expect(active.className).toMatch(/border-b-bg!/);
	expect(active.className).toMatch(/text-text-1/);

	// Inactive tab stays recessed on the baseline.
	expect(inactive.className).toMatch(/bg-surface-2/);
	expect(inactive.className).toMatch(/text-text-2/);
	expect(inactive.className).not.toMatch(/border-b-bg/);
});

test('controlled Tabs renders icon + count and fires onValueChange on click', async () => {
	const user = userEvent.setup({ delay: null });
	const onValueChange = vi.fn();
	const { getByTestId, getByRole } = render(
		<Tabs
			items={[
				{ key: 'all', label: 'All' },
				{
					key: 'egress',
					label: 'Outbound',
					count: 3,
					icon: <svg data-testid="egress-icon" />,
					testId: 'tab-egress',
				},
			]}
			value="all"
			onValueChange={onValueChange}
		/>,
	);

	// Count is rendered as "(n)" and the leading icon is present.
	expect(getByTestId('tab-egress').textContent).toContain('(3)');
	expect(getByTestId('egress-icon')).toBeTruthy();

	await user.click(getByRole('tab', { name: /Outbound/ }));
	expect(onValueChange).toHaveBeenCalledWith('egress');
});

test('controlled Tabs tracks the selected value as it changes', async () => {
	const user = userEvent.setup({ delay: null });

	function Harness() {
		const [value, setValue] = useState('all');
		return <Tabs items={items} value={value} onValueChange={setValue} />;
	}
	const { getByRole } = render(<Harness />);

	expect(getByRole('tab', { name: 'All' }).getAttribute('aria-selected')).toBe('true');

	await user.click(getByRole('tab', { name: /Outbound/ }));

	// Selection moves: the clicked tab becomes the raised folder tab.
	const egress = getByRole('tab', { name: /Outbound/ });
	expect(egress.getAttribute('aria-selected')).toBe('true');
	expect(egress.className).toMatch(/border-b-bg!/);
	expect(getByRole('tab', { name: 'All' }).getAttribute('aria-selected')).toBe('false');
});

test('activeSurface controls the fill the active tab merges into', () => {
	const { getByRole } = render(
		<Tabs items={items} value="all" onValueChange={() => {}} activeSurface="bg-surface" />,
	);
	const active = getByRole('tab', { name: 'All' });
	expect(active.className).toMatch(/bg-surface\b/);
	expect(active.className).not.toMatch(/bg-bg/);
	// The bottom border colour tracks the surface (important, to cover the baseline).
	expect(active.className).toMatch(/border-b-surface!/);
	expect(active.className).not.toMatch(/border-b-bg!/);
});
