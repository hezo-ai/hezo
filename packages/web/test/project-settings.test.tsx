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
	const sidebarName = await findByTestId('project-sidebar-dashboard', undefined, {
		timeout: 15_000,
	});
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

test('edits the per-project memory limit and persists it', async () => {
	const projectName = uniqueName('Memory Limit Project');
	let ws!: SeededWorkspace;
	let projectSlug = '';
	let projectId = '';

	const { findByRole, findByTestId, getByRole, ctx, user, router } = await renderApp({
		initialPath: '/',
		seed: async (seedCtx) => {
			ws = await seedWorkspace();
			const project = await seedProject(ws, {
				name: projectName,
				description: 'Memory limit settings.',
			});
			projectSlug = project.slug;
			projectId = project.id;
			// A per-project cap larger than the whole instance budget can never be
			// scheduled, so it is refused where it is set. Give the instance room for
			// the 24 GB this test asks for - otherwise the assertion depends on how
			// much RAM the machine running the suite happens to have.
			await seedCtx.db.query(
				`INSERT INTO system_meta (key, value) VALUES ('max_container_memory_gb', '64')
				 ON CONFLICT (key) DO UPDATE SET value = '64'`,
			);
		},
	});

	// On the project's **Container** page now, not its General settings: it is a
	// property of the containers and only means anything beside their state.
	await router.navigate({
		to: '/projects/$projectId/container',
		params: { projectId: projectSlug },
	});

	// Read view shows the no-override state: the container inherits the
	// instance-wide ram cap.
	const readValue = await findByTestId('project-memory-limit-value', undefined, { timeout: 8_000 });
	expect(readValue.textContent).toContain('Instance default');

	await user.click(await findByTestId('project-memory-limit-edit'));
	const input = (await findByTestId('project-memory-limit-input', undefined, {
		timeout: 8_000,
	})) as HTMLInputElement;
	await user.clear(input);
	await user.type(input, '24');
	await user.click(await findByTestId('project-memory-limit-save'));

	await waitFor(
		async () => {
			const row = await ctx.db.query<{ memory_limit_gib: number | null }>(
				'SELECT memory_limit_gib FROM projects WHERE id = $1',
				[projectId],
			);
			expect(row.rows[0]?.memory_limit_gib).toBe(24);
		},
		{ timeout: 8_000 },
	);

	// Clearing the field removes the override — back to inherit (NULL).
	await user.click(await findByTestId('project-memory-limit-edit'));
	const input2 = (await findByTestId('project-memory-limit-input', undefined, {
		timeout: 8_000,
	})) as HTMLInputElement;
	await user.clear(input2);
	await user.click(await findByTestId('project-memory-limit-save'));

	await waitFor(
		async () => {
			const row = await ctx.db.query<{ memory_limit_gib: number | null }>(
				'SELECT memory_limit_gib FROM projects WHERE id = $1',
				[projectId],
			);
			expect(row.rows[0]?.memory_limit_gib).toBeNull();
		},
		{ timeout: 8_000 },
	);
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
