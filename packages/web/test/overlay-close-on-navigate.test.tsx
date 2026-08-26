// Regression: a navigation must not leave an overlay covering the page it opened.
//
// The create-project dialog (via `ProjectRail`), the mobile nav drawer and the
// CEO chat are all rendered by `ShellChrome`/`ShellLayout` in routes/__root.tsx,
// ABOVE the <Outlet />. They never unmount on a client-side navigation, so their
// `open` state survives it — and a full-screen Radix modal (overlay z-[80],
// content z-[90]) was left parked over the container page the reader had just
// asked for by clicking "View container". `useCloseOnRouteChange` closes them on
// a real pathname change; the last test pins the guard that keeps it from firing
// on a hash-only one.
//
// Component tier per the AGENTS.md decision tree: these assert unmounting (React
// state + DOM presence), not layout, and both rails and the drawer are
// state-mounted — only their visibility is class-driven, and happy-dom loads no
// Tailwind. project-rail.test.tsx already drives the drawer at this tier.
//
// The chat is the one surface split across tiers, because its rule is
// viewport-conditional (only the presentations that BLOCK the page close). happy-dom
// implements matchMedia and reports a 1024px viewport, so this file covers the two
// desktop branches — anchored survives, expanded collapses — and the mobile
// full-screen sheet is covered in test/browser/chat.spec.ts ("dismissal on navigation").

import { screen, waitFor, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { type SeededWorkspace, seedProject, seedWorkspace } from './helpers/seed';

/** Put HQ mid-provision so the HQ-gated surfaces render their blocked panel. */
const blockHqContainer = (db: { query: (sql: string) => Promise<unknown> }) =>
	db.query(`UPDATE projects SET container_status = 'creating' WHERE is_internal = true`);

const dialogGone = () =>
	waitFor(() => {
		expect(screen.queryByTestId('create-project-dialog')).toBeNull();
		// Nothing of the modal layer survives — overlay included.
		expect(screen.queryByRole('dialog')).toBeNull();
	});

test('the create-project dialog closes when its "View container" link navigates', async () => {
	const { findByTestId, user, router } = await renderApp({
		initialPath: '/home',
		seed: async (ctx) => {
			await blockHqContainer(ctx.db);
		},
	});

	await user.click(await findByTestId('project-rail-new', undefined, { timeout: 15_000 }));

	const dialog = await screen.findByTestId('create-project-dialog');
	const notice = await within(dialog).findByTestId('hq-container-notice');
	expect(notice.textContent ?? '').toContain('Starting the HQ container');

	await user.click(within(dialog).getByTestId('hq-container-notice-link'));

	await waitFor(() => expect(router.state.location.pathname).toBe('/settings/containers'));
	await dialogGone();
});

test('a navigation from outside the dialog closes it too', async () => {
	let projectSlug = '';
	const { findByTestId, user, router } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			const ws: SeededWorkspace = await seedWorkspace();
			projectSlug = (await seedProject(ws, { name: 'Operations' })).slug;
		},
	});

	await user.click(await findByTestId('project-rail-new', undefined, { timeout: 15_000 }));
	await screen.findByTestId('create-project-dialog');

	// The palette's toggle is a `window` keydown listener in ShellChrome and Radix
	// only intercepts Escape, so Cmd+K fires straight through an open modal and
	// the search dialog stacks on top of it. That is the exposure a per-link
	// onClick fix cannot reach, so assert it exists rather than assuming it away.
	await user.keyboard('{Meta>}k{/Meta}');
	expect(await screen.findByTestId('global-search-dialog')).toBeTruthy();

	// Selecting a result navigates (search-results.tsx `<Link onClick={onSelect}>`).
	// Drive the navigation directly so the assertion is about the route change
	// itself and not about typing through two stacked focus scopes.
	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: projectSlug },
	});

	await waitFor(() =>
		expect(router.state.location.pathname).toBe(`/projects/${projectSlug}/tasks`),
	);
	await dialogGone();
});

test('the mobile nav drawer closes when a rail link navigates', async () => {
	let projectSlug = '';
	const { findByTestId, getByTestId, user, router } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			const ws: SeededWorkspace = await seedWorkspace();
			projectSlug = (await seedProject(ws, { name: 'Operations' })).slug;
		},
	});

	await findByTestId('project-rail', undefined, { timeout: 15_000 });
	await user.click(getByTestId('mobile-nav-toggle'));
	const drawer = await findByTestId('mobile-nav-drawer');

	// The drawer hosts a SECOND ProjectRail, so every rail testid is duplicated —
	// scope to the drawer's copy.
	await user.click(
		await within(drawer).findByTestId(`project-rail-avatar-${projectSlug}`, undefined, {
			timeout: 15_000,
		}),
	);

	// The project route lands on its tasks board, so match the prefix.
	await waitFor(() =>
		expect(router.state.location.pathname).toMatch(new RegExp(`^/projects/${projectSlug}`)),
	);
	await waitFor(() => expect(screen.queryByTestId('mobile-nav-drawer')).toBeNull());
});

test('the anchored chat dock survives navigation', async () => {
	// The deliberate exclusion, worth pinning so nobody "fixes" it later: the
	// anchored desktop corner panel does not cover the page, so it stays open
	// across a navigation. happy-dom reports a 1024px viewport, so this tier is
	// the desktop branch; the mobile full-screen sheet — which DOES strand the
	// reader, and closes — is covered in test/browser/chat.spec.ts.
	const { findByTestId, user, router } = await renderApp({ initialPath: '/home' });

	await user.click(await findByTestId('app-header-chat', undefined, { timeout: 15_000 }));
	await findByTestId('chat-panel');

	await router.navigate({ to: '/settings/containers' });

	await waitFor(() => expect(router.state.location.pathname).toBe('/settings/containers'));
	expect(screen.getByTestId('chat-panel')).toBeTruthy();
});

test('a hash-only navigation leaves the open dialog and its half-filled form alone', async () => {
	const { findByTestId, user, router } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			await seedWorkspace();
		},
	});

	await user.click(await findByTestId('project-rail-new', undefined, { timeout: 15_000 }));
	await screen.findByTestId('create-project-dialog');
	await user.type(screen.getByPlaceholderText('e.g. Marketing Site'), 'Half typed');

	// The comment deep-link executor strips `#comment-…` off the URL once it
	// settles (TanStack patches replaceState), so a hash change must not read as a
	// page change and discard what the operator was typing.
	await router.navigate({ to: '/home', hash: 'anything' });
	await waitFor(() => expect(router.state.location.hash).toBe('anything'));
	await router.navigate({ to: '/home', hash: '' });
	await waitFor(() => expect(router.state.location.hash).toBe(''));

	expect(screen.getByTestId('create-project-dialog')).toBeTruthy();
	expect((screen.getByPlaceholderText('e.g. Marketing Site') as HTMLInputElement).value).toBe(
		'Half typed',
	);
});
