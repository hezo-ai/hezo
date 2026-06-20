import { screen, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { type SeededWorkspace, seedProject, seedWorkspace } from './helpers/seed';

test('home "New project" opens the create-project-with-team dialog (type picker)', async () => {
	let ws!: SeededWorkspace;
	const { findByTestId, user } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			ws = await seedWorkspace();
			await seedProject(ws, { name: 'Existing Project' });
			// /home defaults to the active team; point it at the seeded one so its
			// onboarding resolves a primary project (which renders the projects list).
			sessionStorage.setItem('hezo:activeTeamSlug', ws.team.slug);
		},
	});

	// The dashboard's projects section renders once the team has a project; its
	// own "New project" button is testid-scoped so the team rail's affordance
	// (same label) can't match.
	const section = await findByTestId('home-projects', undefined, { timeout: 15_000 });
	await user.click(within(section).getByTestId('home-new-project'));

	// The project-with-team dialog (not the old team-scoped one) has a type picker.
	await screen.findByTestId('create-project-submit');
	expect(screen.getByText('Team type')).toBeTruthy();
	expect(screen.getByPlaceholderText('e.g. Marketing Site')).toBeTruthy();
});
