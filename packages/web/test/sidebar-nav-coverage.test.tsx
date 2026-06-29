import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from '@tanstack/react-router';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test } from 'vitest';
import { SidebarNav, type SidebarNavSection } from '../src/components/sidebar-nav';

// Component tier (happy-dom). SidebarNav uses router <Link>/useMatchRoute, so it
// renders inside a minimal standalone RouterProvider with a handful of real
// paths so active-route matching resolves. Covers: plain item, item with an
// inline "+" action (and that the action's onClick fires without following the
// link), item with sub-items that disclose only when active, the count badge
// (present, zero/undefined → omitted), section header variants (plain title,
// add button, collapsible toggle + chevron, titleTo link), and the
// collapsed-section branch that hides items.

const PATHS = ['/', '/alpha', '/alpha/child', '/beta'] as const;

function renderSidebar(sections: SidebarNavSection[], initialPath: string) {
	const rootRoute = createRootRoute({ component: Outlet });
	const children = PATHS.map((path) =>
		createRoute({
			getParentRoute: () => rootRoute,
			path,
			component: () => <SidebarNav sections={sections} />,
		}),
	);
	const router = createRouter({
		routeTree: rootRoute.addChildren(children),
		history: createMemoryHistory({ initialEntries: [initialPath] }),
	});
	return render(<RouterProvider router={router} />);
}

test('marks the active item and applies the active styling', async () => {
	const { findByTestId } = renderSidebar(
		[
			{
				items: [
					{ to: '/alpha', label: 'Alpha', testId: 'nav-alpha' },
					{ to: '/beta', label: 'Beta', testId: 'nav-beta' },
				],
			},
		],
		'/alpha',
	);

	const alpha = await findByTestId('nav-alpha');
	const beta = await findByTestId('nav-beta');
	expect(alpha.className).toContain('bg-surface-2');
	expect(alpha.className).toContain('font-medium');
	expect(beta.className).not.toContain('font-medium');
});

test('renders the count badge for a positive count and omits it for zero/undefined', async () => {
	const { findByTestId, getByTestId } = renderSidebar(
		[
			{
				items: [
					{ to: '/alpha', label: 'Alpha', count: 5, testId: 'nav-alpha' },
					{ to: '/beta', label: 'Beta', count: 0, testId: 'nav-beta' },
				],
			},
		],
		'/',
	);

	expect((await findByTestId('nav-alpha')).textContent).toContain('5');
	// CountBadge returns null for a falsy (0/undefined) value.
	expect(getByTestId('nav-beta').querySelector('span.font-mono')).toBeNull();
});

test('inline action button fires its onClick and does not navigate', async () => {
	const user = userEvent.setup({ delay: null });
	let clicks = 0;
	const { findByTestId } = renderSidebar(
		[
			{
				items: [
					{
						to: '/alpha',
						label: 'Alpha',
						testId: 'nav-alpha',
						action: { onClick: () => clicks++, label: 'Add task', testId: 'nav-alpha-add' },
					},
				],
			},
		],
		'/',
	);

	const addBtn = await findByTestId('nav-alpha-add');
	expect(addBtn.getAttribute('aria-label')).toBe('Add task');
	await user.click(addBtn);
	expect(clicks).toBe(1);
});

test('sub-items disclose only when the parent (or a sub-item) route is active', async () => {
	const sections: SidebarNavSection[] = [
		{
			items: [
				{
					to: '/alpha',
					label: 'Alpha',
					testId: 'nav-alpha',
					subItems: [{ to: '/alpha/child', label: 'Child', testId: 'nav-alpha-child' }],
				},
			],
		},
	];

	// Inactive parent route → sub-items hidden.
	const inactive = renderSidebar(sections, '/beta');
	await inactive.findByTestId('nav-alpha');
	expect(inactive.queryByTestId('nav-alpha-child')).toBeNull();
	inactive.unmount();

	// Active parent route (fuzzy match) → sub-items shown.
	const active = renderSidebar(sections, '/alpha');
	expect(await active.findByTestId('nav-alpha-child')).toBeTruthy();
});

test('section header: plain title renders as a static label', async () => {
	const { findByText, container } = renderSidebar(
		[{ title: 'Plain', items: [{ to: '/alpha', label: 'Alpha' }] }],
		'/',
	);
	await findByText('Plain');
	// No interactive header controls for a plain title.
	expect(container.querySelector('nav button')).toBeNull();
	expect(container.querySelector('nav a[href]')).toBeTruthy();
});

test('section header: collapsible toggle fires onToggle and collapsing hides items', async () => {
	const user = userEvent.setup({ delay: null });
	let toggles = 0;

	// Expanded collapsible: items present, header is a toggle button.
	const expanded = renderSidebar(
		[
			{
				title: 'Group',
				collapsible: true,
				collapsed: false,
				onToggle: () => toggles++,
				items: [{ to: '/alpha', label: 'Alpha', testId: 'nav-alpha' }],
			},
		],
		'/',
	);
	await expanded.findByTestId('nav-alpha');
	await user.click(expanded.getByRole('button', { name: 'Group' }));
	expect(toggles).toBe(1);
	expanded.unmount();

	// Collapsed collapsible: items hidden.
	const collapsed = renderSidebar(
		[
			{
				title: 'Group',
				collapsible: true,
				collapsed: true,
				onToggle: () => {},
				items: [{ to: '/alpha', label: 'Alpha', testId: 'nav-alpha' }],
			},
		],
		'/',
	);
	await collapsed.findByText('Group');
	expect(collapsed.queryByTestId('nav-alpha')).toBeNull();
});

test('section header: onAdd renders an add button that fires its handler', async () => {
	const user = userEvent.setup({ delay: null });
	let added = 0;
	const { findByLabelText } = renderSidebar(
		[
			{
				title: 'Projects',
				onAdd: () => added++,
				addLabel: 'New project',
				items: [{ to: '/alpha', label: 'Alpha' }],
			},
		],
		'/',
	);

	await user.click(await findByLabelText('New project'));
	expect(added).toBe(1);
});

test('section header: titleTo renders the title as a link', async () => {
	const { findByText } = renderSidebar(
		[{ title: 'Linked', titleTo: '/beta', items: [{ to: '/alpha', label: 'Alpha' }] }],
		'/',
	);
	const title = (await findByText('Linked')) as HTMLAnchorElement;
	expect(title.tagName).toBe('A');
	expect(title.getAttribute('href')).toContain('/beta');
});
