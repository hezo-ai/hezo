import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedProject, seedWorkspace } from './helpers/seed';

test('creates a team-wide goal from the Goals page and opens a Captain ticket', async () => {
	const seeded = { teamSlug: '' };
	const { findByText, findByRole, findByLabelText, router, user } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			await seedProject(ws, { name: 'Goals Product' });
			seeded.teamSlug = ws.team.slug;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/goals',
		params: { teamId: seeded.teamSlug },
	});

	await findByRole('heading', { name: 'Goals' }, { timeout: 10_000 });

	await user.click(await findByRole('button', { name: 'New goal' }));

	const titleInput = await findByLabelText('Title');
	await user.type(titleInput, 'Raise seed round');
	const descInput = await findByLabelText('Description');
	await user.type(descInput, 'Close a $2M seed by end of Q3.');

	await user.click(await findByRole('button', { name: 'Create' }));

	await findByText('Raise seed round', undefined, { timeout: 10_000 });
	await findByText('Team-wide', undefined, { timeout: 10_000 });

	// Navigate to internal-project tasks and confirm the Captain ticket landed there.
	await router.navigate({
		to: '/teams/$teamId/projects/$projectId/tasks',
		params: { teamId: seeded.teamSlug, projectId: 'internal' },
	});
	await findByText('Review plans for goal: "Raise seed round"', undefined, { timeout: 15_000 });
});

test('project-scoped goal routes the Captain ticket into that project', async () => {
	const seeded = { teamSlug: '', projectSlug: '' };
	const { findByText, findByRole, findByLabelText, router, user } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Growth' });
			seeded.teamSlug = ws.team.slug;
			seeded.projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/goals',
		params: { teamId: seeded.teamSlug },
	});

	await findByRole('heading', { name: 'Goals' }, { timeout: 10_000 });
	await user.click(await findByRole('button', { name: 'New goal' }));

	await user.type(await findByLabelText('Title'), 'Launch public v1');
	await user.type(await findByLabelText('Description'), 'Ship the API to the public.');

	const scopeSelect = (await findByLabelText('Scope')) as HTMLSelectElement;
	const projectOption = Array.from(scopeSelect.options).find((o) => o.text === 'Growth');
	expect(projectOption).toBeTruthy();
	await user.selectOptions(scopeSelect, projectOption!.value);

	await user.click(await findByRole('button', { name: 'Create' }));

	await findByText('Launch public v1', undefined, { timeout: 10_000 });

	await router.navigate({
		to: '/teams/$teamId/projects/$projectId/tasks',
		params: { teamId: seeded.teamSlug, projectId: seeded.projectSlug },
	});
	await findByText('Review plans for goal: "Launch public v1"', undefined, { timeout: 15_000 });
});
