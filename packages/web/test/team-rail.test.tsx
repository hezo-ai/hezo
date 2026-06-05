import { screen, waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedWorkspace } from './helpers/seed';

test('rail is a thin global rail with no per-team avatars', async () => {
	let teamA = '';
	let teamB = '';
	const { findByTestId, queryByTestId } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			const a = await seedWorkspace();
			const b = await seedWorkspace();
			teamA = a.team.slug;
			teamB = b.team.slug;
		},
	});

	// Global quick links + the create affordance are present.
	await findByTestId('team-rail-home');
	await findByTestId('team-rail-all-tasks');
	await findByTestId('team-rail-new');

	// Projects-primary: the rail no longer lists per-team avatars — project-teams
	// are reached through Home / All Tasks.
	expect(queryByTestId(`team-rail-team-${teamA}`)).toBeNull();
	expect(queryByTestId(`team-rail-team-${teamB}`)).toBeNull();
});

test('rail exposes instance-resource shortcuts that navigate to the settings pages', async () => {
	const { findByTestId, getByTestId, user, router } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			await seedWorkspace();
		},
	});

	// Superuser sees the instance shortcuts + Settings.
	await findByTestId('team-rail-skills');
	getByTestId('team-rail-connectors');
	getByTestId('team-rail-credentials');
	getByTestId('team-rail-settings');

	await user.click(getByTestId('team-rail-skills'));
	await waitFor(() => expect(router.state.location.pathname).toBe('/settings/skills'));
});

test('superuser creates a new project (with its own team) from the rail', async () => {
	const { findByTestId, user, router } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			await seedWorkspace();
		},
	});

	await user.click(await findByTestId('team-rail-new'));

	// Dialog content renders into a Radix portal on document.body — query via screen.
	await user.type(screen.getByPlaceholderText('e.g. Marketing Site'), 'Research Squad');
	await user.type(
		screen.getByPlaceholderText(/What is this project/),
		'A research project for the launch.',
	);
	await user.click(await screen.findByTestId('team-type-card-Blank'));
	await user.click(screen.getByTestId('create-project-submit'));

	// Navigates into the new team's intake conversation (its Internal project).
	await waitFor(() =>
		expect(router.state.location.pathname).toMatch(
			/^\/teams\/research-squad\/projects\/internal\/tasks\//,
		),
	);
});
