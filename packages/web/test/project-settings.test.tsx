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

	// The settings page renders the project's description only once the route's
	// useProject query resolves, so waiting on it confirms the page loaded with
	// the project's data.
	await findByText('Test project settings.', undefined, { timeout: 15_000 });
	const sidebarName = await findByTestId('project-sidebar-name', undefined, { timeout: 15_000 });
	await waitFor(() => expect(sidebarName.textContent).toContain(projectName));
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

	const { findByLabelText, findByRole, queryByText, user, router } = await renderApp({
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

	// Cancel returns to the read-only view (the Edit button reappears) and the
	// typed-but-discarded name is not shown.
	await findByRole('button', { name: 'Edit' });
	expect(queryByText('Should Not Save')).toBeNull();
});

test('the memory limit has moved off General onto the project Concurrency page', async () => {
	// A negative assertion, so the move cannot be half-done: leaving the field on
	// both pages would give two controls writing the same column.
	const projectName = uniqueName('Memory Moved Project');
	let ws!: SeededWorkspace;
	let projectSlug = '';

	const { findByRole, queryByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			const project = await seedProject(ws, { name: projectName, description: 'General only.' });
			projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/settings',
		params: { projectId: projectSlug },
	});

	await user.click(await findByRole('button', { name: 'Edit' }));
	expect(queryByTestId('memory-limit-gib-input')).toBeNull();
	expect(queryByTestId('memory-limit-gib-value')).toBeNull();
});

test('edits the project budget limits from settings and persists them', async () => {
	const projectName = uniqueName('Budget Settings Project');
	let ws!: SeededWorkspace;
	let projectSlug = '';
	let projectId = '';

	const { findByTestId, findByRole, getByRole, ctx, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			const project = await seedProject(ws, {
				name: projectName,
				description: 'Budget settings.',
			});
			projectSlug = project.slug;
			projectId = project.id;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/settings',
		params: { projectId: projectSlug },
	});

	// The budget editor lives in its own "Edit caps" affordance, distinct from the
	// General section's "Edit".
	await user.click(await findByTestId('edit-project-budget'));
	await user.click(await findByTestId('budget-daily-toggle'));
	const daily = (await findByTestId('budget-daily')) as HTMLInputElement;
	await user.clear(daily);
	await user.type(daily, '15');
	await user.click(getByRole('button', { name: 'Save' }));

	await waitFor(
		async () => {
			const row = await ctx.db.query<{ daily_budget_cents: number }>(
				'SELECT daily_budget_cents FROM projects WHERE id = $1',
				[projectId],
			);
			expect(row.rows[0]?.daily_budget_cents).toBe(1500);
		},
		{ timeout: 8_000 },
	);

	// Returns to the read-only view (the "Edit caps" button reappears).
	await findByRole('button', { name: 'Edit caps' });
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
		to: '/projects/$projectId/git',
		params: { projectId: projectSlug },
	});

	await findByRole('heading', { name: 'GitHub' }, { timeout: 15_000 });
	await findByTestId('github-state-disconnected');
	await findByTestId('github-connect');
});
