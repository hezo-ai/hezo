import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { type SeededWorkspace, seedProject, seedWorkspace } from './helpers/seed';

function uniqueName(base: string): string {
	return `${base} ${Math.random().toString(36).slice(2, 8)}`;
}

test('displays project name and description', async () => {
	const projectName = uniqueName('Settings Project');
	let ws!: SeededWorkspace;
	let projectSlug = '';

	const { findByTestId, findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			const project = await seedProject(ws, {
				name: projectName,
				description: 'Test project settings.',
			});
			projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/settings',
		params: { projectId: projectSlug },
	});

	const breadcrumb = await findByTestId('breadcrumb', undefined, { timeout: 15_000 });
	// The sidebar's project-list query resolves earlier than the route layout's
	// useProject, so polling on findByText(projectName) can match the sidebar
	// while the breadcrumb still shows the slug fallback. Wait on the
	// breadcrumb itself.
	await waitFor(() => expect(breadcrumb.textContent).toContain('Settings'), {
		timeout: 15_000,
	});
	await findByText('Test project settings.', undefined, { timeout: 10_000 });
});

test('can edit project description', async () => {
	const projectName = uniqueName('Settings Project');
	let ws!: SeededWorkspace;
	let projectSlug = '';

	const { findByLabelText, findByRole, getByRole, findByText, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			const project = await seedProject(ws, {
				name: projectName,
				description: 'Test project settings.',
			});
			projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/settings',
		params: { projectId: projectSlug },
	});

	await user.click(await findByRole('button', { name: 'Edit' }));

	const desc = (await findByLabelText('Description')) as HTMLTextAreaElement;
	await user.clear(desc);
	await user.type(desc, 'Updated description');

	await user.click(getByRole('button', { name: 'Save' }));

	await findByText('Updated description', undefined, { timeout: 15_000 });
});

test('cancel button discards edits', async () => {
	const projectName = uniqueName('Settings Project');
	let ws!: SeededWorkspace;
	let projectSlug = '';

	const { findByLabelText, findByRole, findByTestId, queryByText, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			const project = await seedProject(ws, {
				name: projectName,
				description: 'Test project settings.',
			});
			projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/settings',
		params: { projectId: projectSlug },
	});

	await user.click(await findByRole('button', { name: 'Edit' }));

	const nameInput = (await findByLabelText('Name')) as HTMLInputElement;
	await user.clear(nameInput);
	await user.type(nameInput, 'Should Not Save');

	await user.click(await findByRole('button', { name: 'Cancel' }));

	const breadcrumb = await findByTestId('breadcrumb');
	expect(breadcrumb.textContent).toContain('Settings');
	expect(queryByText('Should Not Save')).toBeNull();
});

test('edits the per-project concurrency cap and persists it', async () => {
	const projectName = uniqueName('Concurrency Project');
	let ws!: SeededWorkspace;
	let projectSlug = '';
	let projectId = '';

	const { findByRole, findByTestId, getByRole, ctx, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			const project = await seedProject(ws, {
				name: projectName,
				description: 'Concurrency settings.',
			});
			projectSlug = project.slug;
			projectId = project.id;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/settings',
		params: { projectId: projectSlug },
	});

	// Read view shows the seeded default of 3.
	const readValue = await findByTestId('max-concurrent-runs-value', undefined, { timeout: 8_000 });
	expect(readValue.textContent).toContain('3');

	await user.click(await findByRole('button', { name: 'Edit' }));
	const input = (await findByTestId('max-concurrent-runs-input', undefined, {
		timeout: 8_000,
	})) as HTMLInputElement;
	await user.clear(input);
	await user.type(input, '5');
	await user.click(getByRole('button', { name: 'Save' }));

	// The optimistic mutation hits the real backend; the project row reflects it.
	await waitFor(
		async () => {
			const row = await ctx.db.query<{ max_concurrent_runs: number }>(
				'SELECT max_concurrent_runs FROM projects WHERE id = $1',
				[projectId],
			);
			expect(row.rows[0]?.max_concurrent_runs).toBe(5);
		},
		{ timeout: 8_000 },
	);
});

test('State A — no GitHub connection: shows Connect GitHub CTA', async () => {
	const projectName = uniqueName('Settings Project');
	let ws!: SeededWorkspace;
	let projectSlug = '';

	const { findByRole, findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			const project = await seedProject(ws, {
				name: projectName,
				description: 'Test project settings.',
			});
			projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/settings',
		params: { projectId: projectSlug },
	});

	await findByRole('heading', { name: 'GitHub' }, { timeout: 15_000 });
	await findByTestId('github-state-disconnected');
	await findByTestId('github-connect');
});
