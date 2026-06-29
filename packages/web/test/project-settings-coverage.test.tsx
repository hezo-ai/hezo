import { HQ_PROJECT_SLUG } from '@hezo/shared';
import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { seedProject, seedWorkspace } from './helpers/seed';

function uniqueName(base: string): string {
	return `${base} ${Math.random().toString(36).slice(2, 8)}`;
}

// Branch: beforeLoad redirects the HQ project away from the settings page to its
// task board (the HQ_PROJECT_SLUG guard).
test('HQ project redirects away from the settings page to its tasks', async () => {
	const { router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			await seedWorkspace();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/settings',
		params: { projectId: HQ_PROJECT_SLUG },
	});

	await waitFor(() =>
		expect(router.state.location.pathname).toBe(`/projects/${HQ_PROJECT_SLUG}/tasks`),
	);
});

// Branch: the read view omits the Description row when the project has no
// description (the `project.description && ...` conditional).
test('read view omits the description row when the project has none', async () => {
	const projectName = uniqueName('No Desc Project');
	let projectSlug = '';
	const { findByTestId, queryByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			// seedProject with no description leaves it null/empty.
			const project = await seedProject(ws, { name: projectName });
			projectSlug = project.slug;
			// Ensure description is empty so the `project.description && ...`
			// conditional is false (the column is NOT NULL, so use '').
			await getTestContext().db.query(`UPDATE projects SET description = '' WHERE id = $1`, [
				project.id,
			]);
		},
	});

	await router.navigate({
		to: '/projects/$projectId/settings',
		params: { projectId: projectSlug },
	});

	// Read view loaded (the max-runs value row is present).
	await findByTestId('max-concurrent-runs-value', undefined, { timeout: 15_000 });
	// No "Description:" label in the read view.
	expect(queryByText('Description:')).toBeNull();
});

// Branch: Dev Preview section renders when container_status === 'running' AND
// dev_ports has entries.
test('renders the Dev Preview section when the container is running with dev ports', async () => {
	const projectName = uniqueName('Dev Ports Project');
	let projectSlug = '';
	const { findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, {
				name: projectName,
				description: 'Has dev ports.',
			});
			projectSlug = project.slug;
			await getTestContext().db.query(
				`UPDATE projects
				 SET container_status = 'running',
				     dev_ports = '[{"container":3000,"host":34000}]'::jsonb
				 WHERE id = $1`,
				[project.id],
			);
		},
	});

	await router.navigate({
		to: '/projects/$projectId/settings',
		params: { projectId: projectSlug },
	});

	await findByText('Dev Preview', undefined, { timeout: 15_000 });
	// The port link renders the container → host mapping.
	const link = await findByText(/3000 → :34000/);
	expect((link.closest('a') as HTMLAnchorElement).getAttribute('href')).toBe(
		'http://localhost:34000',
	);
});

// Branch: editing with an invalid (sub-1 / non-integer) max-runs value falls back
// to undefined so the persisted value is unchanged.
test('an invalid max-concurrent-runs entry leaves the persisted value unchanged', async () => {
	const projectName = uniqueName('Invalid Runs Project');
	let projectSlug = '';
	let projectId = '';
	const { findByRole, findByTestId, getByRole, ctx, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, {
				name: projectName,
				description: 'Invalid runs.',
			});
			projectSlug = project.slug;
			projectId = project.id;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/settings',
		params: { projectId: projectSlug },
	});

	const before = await ctx.db.query<{ max_concurrent_runs: number }>(
		'SELECT max_concurrent_runs FROM projects WHERE id = $1',
		[projectId],
	);
	const original = before.rows[0].max_concurrent_runs;

	// Wait for the read view to load before entering edit mode.
	await findByTestId('max-concurrent-runs-value', undefined, { timeout: 15_000 });
	await user.click(await findByRole('button', { name: 'Edit' }));
	const input = (await findByTestId('max-concurrent-runs-input')) as HTMLInputElement;
	await user.clear(input);
	await user.type(input, '0'); // < 1 → undefined → unchanged
	await user.click(getByRole('button', { name: 'Save' }));

	// The save omits max_concurrent_runs (the guard maps it to undefined), so the
	// persisted value is untouched.
	await waitFor(async () => {
		const row = await ctx.db.query<{ max_concurrent_runs: number }>(
			'SELECT max_concurrent_runs FROM projects WHERE id = $1',
			[projectId],
		);
		expect(row.rows[0].max_concurrent_runs).toBe(original);
	});
});
