// Branch-coverage for the presentational SidebarNav. It only depends on the
// router (Link + useMatchRoute), so it's rendered in a minimal root-route
// harness rather than the full app. Covers the section-header variants
// (plain/titleTo/onAdd), item variants (plain/action/sub-items), the active vs
// sub-active disclosure branches, and the CountBadge falsy/truthy branch.

import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from '@tanstack/react-router';
import { render, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { SidebarNav, type SidebarNavSection } from '../src/components/sidebar-nav';

// The RouterProvider resolves its pending route on a microtask, so the nav is
// not in the DOM synchronously after render — wait for it to mount.
async function renderNav(sections: SidebarNavSection[], initialPath = '/') {
	const rootRoute = createRootRoute({ component: () => <SidebarNav sections={sections} /> });
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: [initialPath] }),
	});
	const utils = render(
		// biome-ignore lint/suspicious/noExplicitAny: opaque router type at the test boundary.
		<RouterProvider router={router as any} />,
	);
	await waitFor(() =>
		expect(utils.container.querySelector('nav[aria-label="Sidebar"]')).not.toBeNull(),
	);
	return utils;
}

function getNav(container: HTMLElement): HTMLElement {
	const nav = container.querySelector('nav[aria-label="Sidebar"]');
	if (!nav) throw new Error('nav not mounted');
	return nav as HTMLElement;
}

test('plain section header (no collapsible/onAdd/titleTo) renders the title as a bare div', async () => {
	const { container } = await renderNav([{ title: 'Plain', items: [{ to: '/', label: 'Home' }] }]);
	const nav = getNav(container);
	// The title text shows; there is no toggle/add button in this header variant.
	expect(within(nav).getByText('Plain')).toBeTruthy();
	expect(within(nav).queryByRole('button')).toBeNull();
});

test('untitled section uses the index-based key and renders its items without a header', async () => {
	const { container } = await renderNav([{ items: [{ to: '/', label: 'NoHeaderItem' }] }]);
	const nav = getNav(container);
	expect(within(nav).getByText('NoHeaderItem')).toBeTruthy();
	// No uppercase section-title div is emitted for a titleless section.
	expect(nav.querySelector('.uppercase')).toBeNull();
});

test('CountBadge: shows a positive count and hides zero/undefined', async () => {
	const { container } = await renderNav([
		{
			items: [
				{ to: '/', label: 'WithCount', count: 7 },
				{ to: '/zero', label: 'ZeroCount', count: 0 },
				{ to: '/none', label: 'NoCount' },
			],
		},
	]);
	const nav = getNav(container);
	expect(within(nav).getByText('7')).toBeTruthy();
	// 0 is falsy → no badge; "ZeroCount"/"NoCount" rows have no numeric badge.
	expect(within(nav).queryByText('0')).toBeNull();
});

test('item with an inline action makes the whole row a link and the "+" fires onClick without navigating', async () => {
	const onClick = vi.fn();
	const { container } = await renderNav([
		{
			items: [
				{
					to: '/tasks',
					label: 'Tasks',
					action: { onClick, label: 'New task', testId: 'add-task' },
				},
			],
		},
	]);
	const nav = getNav(container);
	// The entire row is a single link to the destination — clicking anywhere on it
	// (not just the label) navigates.
	const row = within(nav).getByText('Tasks').closest('a');
	expect(row?.getAttribute('href')).toBe('/tasks');
	// The "+" lives inside that link but intercepts its own click.
	const btn = within(nav).getByRole('button', { name: 'New task' });
	expect(row?.contains(btn)).toBe(true);
	await userEvent.setup({ delay: null }).click(btn);
	expect(onClick).toHaveBeenCalledTimes(1);
});

test('section header with onAdd renders an Add button that fires its handler', async () => {
	const onAdd = vi.fn();
	const { container } = await renderNav([
		{ title: 'Projects', onAdd, addLabel: 'Add project', items: [] },
	]);
	const nav = getNav(container);
	const addBtn = within(nav).getByRole('button', { name: 'Add project' });
	await userEvent.setup({ delay: null }).click(addBtn);
	expect(onAdd).toHaveBeenCalledTimes(1);
});

test('section header with onAdd but no addLabel falls back to "Add"', async () => {
	const { container } = await renderNav([{ title: 'Things', onAdd: vi.fn(), items: [] }]);
	const nav = getNav(container);
	expect(within(nav).getByRole('button', { name: 'Add' })).toBeTruthy();
});

test('titleTo header renders the whole header as a link to the destination, with no collapse chevron', async () => {
	const { container } = await renderNav([
		{
			title: 'Team',
			titleTo: '/team',
			items: [{ to: '/', label: 'AgentRow' }],
		},
	]);
	const nav = getNav(container);
	const titleLink = within(nav).getByRole('link', { name: 'Team' });
	expect(titleLink.getAttribute('href')).toBe('/team');
	// Expand/collapse is gone — items always render and there is no chevron toggle.
	expect(within(nav).getByText('AgentRow')).toBeTruthy();
	expect(within(nav).queryByRole('button', { name: 'Collapse' })).toBeNull();
	expect(within(nav).queryByRole('button', { name: 'Expand' })).toBeNull();
});

test('titleTo header with onAdd nests the "+" inside the header link and fires onAdd', async () => {
	const onAdd = vi.fn();
	const { container } = await renderNav([
		{ title: 'Team', titleTo: '/team', onAdd, addLabel: 'Hire', items: [] },
	]);
	const nav = getNav(container);
	const titleLink = within(nav).getByRole('link', { name: /Team/ });
	const addBtn = within(nav).getByRole('button', { name: 'Hire' });
	expect(titleLink.contains(addBtn)).toBe(true);
	await userEvent.setup({ delay: null }).click(addBtn);
	expect(onAdd).toHaveBeenCalledTimes(1);
});

test('item with sub-items discloses them when the parent route is active', async () => {
	const { container } = await renderNav(
		[
			{
				items: [
					{
						to: '/parent',
						label: 'Parent',
						subItems: [
							{ to: '/parent/child', label: 'Child', count: 3 },
							{ to: '/parent/other', label: 'Other' },
						],
					},
				],
			},
		],
		'/parent',
	);
	const nav = getNav(container);
	expect(within(nav).getByText('Child')).toBeTruthy();
	expect(within(nav).getByText('Other')).toBeTruthy();
	// Sub-item CountBadge renders for the child with a count.
	expect(within(nav).getByText('3')).toBeTruthy();
});

test('item with sub-items keeps them collapsed when neither parent nor sub-item is active', async () => {
	const { container } = await renderNav(
		[
			{
				items: [
					{
						to: '/parent',
						label: 'Parent',
						subItems: [{ to: '/parent/child', label: 'HiddenSub' }],
					},
				],
			},
		],
		'/elsewhere',
	);
	const nav = getNav(container);
	expect(within(nav).queryByText('HiddenSub')).toBeNull();
});

test('sub-active branch: an active sub-item route discloses the list even when the parent is not active', async () => {
	const { container } = await renderNav(
		[
			{
				items: [
					{
						to: '/settings',
						label: 'Settings',
						subItems: [{ to: '/container', label: 'Container' }],
					},
				],
			},
		],
		'/container',
	);
	const nav = getNav(container);
	expect(within(nav).getByText('Container')).toBeTruthy();
});

test('titled section indents its items (pl-4) vs a titleless section (px-2.5)', async () => {
	const titled = await renderNav([{ title: 'T', items: [{ to: '/', label: 'Indented' }] }]);
	const link = within(getNav(titled.container)).getByText('Indented').closest('a');
	expect(link?.className).toContain('pl-4');

	const untitled = await renderNav([{ items: [{ to: '/', label: 'Flush' }] }]);
	const link2 = within(getNav(untitled.container)).getByText('Flush').closest('a');
	expect(link2?.className).toContain('px-2.5');
});
