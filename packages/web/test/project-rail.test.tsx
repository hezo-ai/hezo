import { screen, waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { type SeededWorkspace, seedProject, seedWorkspace } from './helpers/seed';

test('the project rail lists an avatar for every visible project across teams', async () => {
	let alphaSlug = '';
	let betaSlug = '';
	const { findByTestId } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			const a = await seedWorkspace();
			const b = await seedWorkspace();
			const alpha = await seedProject(a, { name: 'Alpha' });
			const beta = await seedProject(b, { name: 'Beta' });
			alphaSlug = alpha.slug;
			betaSlug = beta.slug;
		},
	});

	await findByTestId(`project-rail-avatar-${alphaSlug}`, undefined, { timeout: 15_000 });
	await findByTestId(`project-rail-avatar-${betaSlug}`, undefined, { timeout: 15_000 });
});

test('clicking a project avatar opens that project menu', async () => {
	let ws!: SeededWorkspace;
	let slug = '';
	const { findByTestId, user, router } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			ws = await seedWorkspace();
			const p = await seedProject(ws, { name: 'Operations' });
			slug = p.slug;
		},
	});

	const avatar = await findByTestId(`project-rail-avatar-${slug}`, undefined, { timeout: 15_000 });
	await user.click(avatar);

	await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/projects\//));
	await findByTestId('project-sidebar-name', undefined, { timeout: 15_000 });
});

test('superuser creates a new project from the rail-pinned create button', async () => {
	const { findByTestId, user, router } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			await seedWorkspace();
		},
	});

	await user.click(await findByTestId('project-rail-new'));

	// Dialog renders into a Radix portal on document.body — query via screen.
	await user.type(screen.getByPlaceholderText('e.g. Marketing Site'), 'Research Squad');
	await user.type(
		screen.getByPlaceholderText(/What is this project/),
		'A research project for the launch.',
	);
	await user.click(await screen.findByTestId('team-type-card-Blank'));
	await user.click(screen.getByTestId('create-project-submit'));

	await waitFor(() =>
		expect(router.state.location.pathname).toMatch(/^\/projects\/internal-research-squad\/tasks\//),
	);
});
