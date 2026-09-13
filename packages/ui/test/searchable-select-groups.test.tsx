// Group headings and the unread badge on `SearchableSelect`. Both exist for the
// chat room switcher, which replaced a native <select> + <optgroup> - the only
// optgroup in the repo - and so needed section labels a popover could draw.
// Options render in a Radix portal: query `document.body`, not the container.

import { SearchableSelect, type SearchableSelectOption } from '@hezo/ui';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test } from 'vitest';

const OPTIONS: SearchableSelectOption[] = [
	{ value: 'ceo', label: 'CEO · HQ' },
	{ value: 'captain', label: 'Captain', group: 'Hezo Marketing' },
	{ value: 'engineer', label: 'Engineer', group: 'Hezo Marketing' },
	{ value: 'x-eng', label: 'X Engagement Specialist', group: 'Hezo Marketing', badge: 'dot' },
	{ value: 'general', label: 'General', group: 'Rooms' },
	{ value: 'audit', label: 'X Engagement Audit', group: 'History' },
];

function open() {
	return render(
		<SearchableSelect
			options={OPTIONS}
			value="ceo"
			onChange={() => {}}
			testId="switcher"
			searchPlaceholder="Search conversations"
			badgeLabel="Unread"
		/>,
	);
}

/** Heading text currently drawn in the portal, in order. */
function headings(): string[] {
	const panel = document.body.querySelector('[data-testid="switcher-content"]');
	return [...(panel?.querySelectorAll('[aria-hidden="true"]') ?? [])]
		.map((el) => el.textContent?.trim() ?? '')
		.filter((t) => ['Hezo Marketing', 'Rooms', 'History'].includes(t));
}

test('a heading draws once per group, and an ungrouped head option draws none', async () => {
	const user = userEvent.setup();
	open();
	await user.click(screen.getByTestId('switcher'));

	// Three groups, each labelled once - not once per option.
	expect(headings()).toEqual(['Hezo Marketing', 'Rooms', 'History']);
	// The pinned CEO row is ungrouped and gets no heading above it.
	expect(headings()).not.toContain('CEO · HQ');
	expect(document.body.querySelectorAll('[role="option"]')).toHaveLength(6);
});

test('filtering drops the headings whose groups have no surviving option', async () => {
	const user = userEvent.setup();
	open();
	await user.click(screen.getByTestId('switcher'));
	await user.type(screen.getByTestId('switcher-search'), 'eng');

	// Engineer + X Engagement Specialist + X Engagement Audit survive, so the two
	// groups they sit in keep their headings and the rest go - a heading over an
	// empty section is the specific bug this prevents.
	expect(headings()).toEqual(['Hezo Marketing', 'History']);
	expect(document.body.querySelectorAll('[role="option"]')).toHaveLength(3);
});

test('a badge dot renders only on the option carrying it, and is named', async () => {
	const user = userEvent.setup();
	open();
	await user.click(screen.getByTestId('switcher'));

	const unread = screen.getAllByText('Unread');
	expect(unread).toHaveLength(1);
	// It belongs to the row that declared it, not to a neighbour.
	expect(unread[0].closest('[role="option"]')).toBe(
		document.body.querySelector('[data-testid="switcher-option-x-eng"]'),
	);
});
