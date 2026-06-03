import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedProject, seedWorkspace } from './helpers/seed';

test('project header shows a team chip linking to team settings', async () => {
	let teamSlug = '';
	let projectSlug = '';
	const { findByRole, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Chip Project' });
			teamSlug = ws.team.slug;
			projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/projects/$projectId',
		params: { teamId: teamSlug, projectId: projectSlug },
	});

	const chip = await findByRole('link', { name: /Team:/ });
	expect(chip.getAttribute('href')).toBe(`/teams/${teamSlug}/settings/general`);
});
