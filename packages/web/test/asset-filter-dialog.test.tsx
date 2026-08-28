// The mobile filter dialog's own contract, rendered directly. It offers sort as
// two parts - the column and the direction - and each pill has to resolve to the
// right `AssetSortOrder` against whichever half is already set; get that pairing
// wrong and picking "Smallest" after "Size" silently lands on a different order.
//
// The dialog only *mounts* below `md`, which needs a real viewport
// (test/browser/asset-list-view.mobile.spec.ts). What it does once mounted needs
// no viewport at all, so it is tested here, at the cheapest tier that can see it.

import { ArchiveFilter, AssetSortField, AssetSortOrder } from '@hezo/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { AssetFilterDialog } from '../src/components/asset-filter-dialog';
import { I18nProvider } from '../src/lib/i18n';

const FILTER_OPTIONS = [
	{ value: ArchiveFilter.Active, label: 'Active', count: 7 },
	{ value: ArchiveFilter.Archived, label: 'Archived', count: 2 },
	{ value: ArchiveFilter.All, label: 'All', count: 9 },
];

const FIELD_OPTIONS = [
	{ value: AssetSortField.Name, label: 'Name' },
	{ value: AssetSortField.Type, label: 'Type' },
	{ value: AssetSortField.Size, label: 'Size' },
	{ value: AssetSortField.Modified, label: 'Modified' },
];

/** As the page labels them for the column in play - Size, in these tests. */
const DIRECTION_OPTIONS = [
	{ value: 'asc' as const, label: 'Smallest' },
	{ value: 'desc' as const, label: 'Largest' },
];

function renderDialog(sort: AssetSortOrder) {
	const onFilterChange = vi.fn();
	const onSortChange = vi.fn();
	render(
		<I18nProvider>
			<AssetFilterDialog
				open
				onOpenChange={() => {}}
				filterOptions={FILTER_OPTIONS}
				filter={ArchiveFilter.Active}
				onFilterChange={onFilterChange}
				fieldOptions={FIELD_OPTIONS}
				directionOptions={DIRECTION_OPTIONS}
				sort={sort}
				onSortChange={onSortChange}
			/>
		</I18nProvider>,
	);
	return { onFilterChange, onSortChange, user: userEvent.setup() };
}

/** The pill track under one of the dialog's three labelled groups. */
function group(name: string): HTMLElement {
	return screen.getByRole('group', { name });
}

test('the three tracks show the state the current order resolves to', () => {
	renderDialog(AssetSortOrder.SizeDesc);

	// Active is the filter; Size is the column; Largest is its direction. Each
	// selected pill is the pressed one in its own group.
	expect(within(group('Show')).getByRole('button', { pressed: true }).textContent).toContain(
		'Active',
	);
	expect(within(group('Sort by')).getByRole('button', { pressed: true }).textContent).toBe('Size');
	expect(within(group('Order')).getByRole('button', { pressed: true }).textContent).toBe('Largest');
});

test('picking a column keeps the direction already set', async () => {
	const { onSortChange, user } = renderDialog(AssetSortOrder.SizeAsc);

	await user.click(within(group('Sort by')).getByRole('button', { name: 'Modified' }));
	// Ascending was in play, so Modified arrives ascending - oldest first - rather
	// than resetting to the column's own default direction.
	expect(onSortChange).toHaveBeenCalledWith(AssetSortField.Modified, 'asc');
});

test('picking a direction keeps the column already set', async () => {
	const { onSortChange, user } = renderDialog(AssetSortOrder.SizeDesc);

	await user.click(within(group('Order')).getByRole('button', { name: 'Smallest' }));
	expect(onSortChange).toHaveBeenCalledWith(AssetSortField.Size, 'asc');
});

test('the filter track reports its own choice and leaves the sort alone', async () => {
	const { onFilterChange, onSortChange, user } = renderDialog(AssetSortOrder.Newest);

	await user.click(within(group('Show')).getByRole('button', { name: /Archived/ }));
	expect(onFilterChange).toHaveBeenCalledWith(ArchiveFilter.Archived);
	expect(onSortChange).not.toHaveBeenCalled();
});

test('each filter pill carries its live count', () => {
	renderDialog(AssetSortOrder.Newest);
	// A narrowed library must never read as an empty one, so the counts ride
	// along with the options rather than being looked up again here.
	expect(within(group('Show')).getByRole('button', { name: /All/ }).textContent).toContain('9');
	expect(within(group('Show')).getByRole('button', { name: /Archived/ }).textContent).toContain(
		'2',
	);
});
