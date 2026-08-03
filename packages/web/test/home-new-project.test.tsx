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

	// The project-with-team dialog (not the old team-scoped one) opens on its entry
	// step: name + description + a "View all teams" affordance. The action buttons
	// stay hidden until a team is picked.
	await screen.findByPlaceholderText('e.g. Marketing Site');
	expect(screen.getByTestId('view-all-teams')).toBeTruthy();
	expect(
		screen.getByPlaceholderText(
			'What is this project? Domain, users, and the core problem it solves.',
		),
	).toBeTruthy();
	expect(screen.queryByTestId('create-project-submit')).toBeNull();
});

test('the create-project dialog blocks on the container state when HQ is down', async () => {
	let ws!: SeededWorkspace;
	const { findByTestId, user } = await renderApp({
		initialPath: '/home',
		seed: async (ctx) => {
			ws = await seedWorkspace();
			await seedProject(ws, { name: 'Existing Project' });
			sessionStorage.setItem('hezo:activeTeamSlug', ws.team.slug);
			await ctx.db.query(`UPDATE projects SET container_status = 'error' WHERE is_internal = true`);
		},
	});

	const section = await findByTestId('home-projects', undefined, { timeout: 15_000 });
	await user.click(within(section).getByTestId('home-new-project'));

	// The form is replaced by the container-state notice + a link to the global
	// Containers page; the create button is gone.
	const notice = await screen.findByTestId('hq-container-notice');
	expect(notice.textContent ?? '').toContain('error');
	expect(screen.queryByTestId('create-project-submit')).toBeNull();
	expect(screen.getByTestId('hq-container-notice-link').getAttribute('href')).toContain(
		'/settings/containers',
	);
});
