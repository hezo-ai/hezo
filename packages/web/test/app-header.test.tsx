import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedWorkspace } from './helpers/seed';

test('header keeps Home top-left and the rest in the top-right group', async () => {
	let ws: { projectSlug: string } | undefined;
	const { findByTestId, getByTestId } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			const w = await seedWorkspace();
			ws = { projectSlug: w.team.slug };
		},
	});
	void ws;

	const header = await findByTestId('app-header');
	const home = getByTestId('app-header-home');
	const inbox = getByTestId('app-header-inbox');
	const allTasks = getByTestId('app-header-all-tasks');
	const settings = getByTestId('app-header-settings');

	// Home is the only quick link before the spacer; Inbox / All Tasks / Settings
	// all live in the trailing group, so Home appears before them in the DOM.
	const order = [home, inbox, allTasks, settings];
	for (let i = 1; i < order.length; i++) {
		expect(home.compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	}
	expect(header.contains(home)).toBe(true);

	// Project creation is no longer in the header.
	expect(header.querySelector('[data-testid="app-header-new"]') ?? null).toBeNull();
});

test('header exposes the Skills shortcut and routes connectors/credentials through Settings', async () => {
	const { findByTestId, getByTestId, queryByTestId, user, router } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			await seedWorkspace();
		},
	});

	await findByTestId('app-header-skills');
	getByTestId('app-header-settings');

	expect(queryByTestId('app-header-connectors')).toBeNull();
	expect(queryByTestId('app-header-credentials')).toBeNull();

	await user.click(getByTestId('app-header-skills'));
	await waitFor(() => expect(router.state.location.pathname).toBe('/settings/skills'));
});
