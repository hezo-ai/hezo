import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import {
	archiveSeededProject,
	type SeededWorkspace,
	seedProject,
	seedWorkspace,
} from './helpers/seed';

function uniqueName(base: string): string {
	return `${base} ${Math.random().toString(36).slice(2, 8)}`;
}

test('archives a project from settings via the confirm dialog', async () => {
	const projectName = uniqueName('Archive Project');
	let ws!: SeededWorkspace;
	let projectSlug = '';
	let projectId = '';

	const { findByTestId, ctx, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			const project = await seedProject(ws, { name: projectName, description: 'To be archived.' });
			projectSlug = project.slug;
			projectId = project.id;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/settings',
		params: { projectId: projectSlug },
	});

	// The superuser-only Danger zone renders the archive affordance.
	await user.click(await findByTestId('archive-project-button', undefined, { timeout: 15_000 }));

	// Confirm in the dialog (portaled onto document.body).
	await user.click(await findByTestId('confirm-dialog-confirm', undefined, { timeout: 8_000 }));

	// The real backend stamps archived_at on the project row.
	await waitFor(
		async () => {
			const row = await ctx.db.query<{ archived_at: string | null }>(
				'SELECT archived_at FROM projects WHERE id = $1',
				[projectId],
			);
			expect(row.rows[0]?.archived_at).not.toBeNull();
		},
		{ timeout: 8_000 },
	);
});

test('unarchives a project from the archived-projects settings page', async () => {
	const projectName = uniqueName('Restore Project');
	let ws!: SeededWorkspace;
	let projectId = '';
	let slug = '';

	const { findByText, findByTestId, queryByTestId, ctx, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			const project = await seedProject(ws, {
				name: projectName,
				description: 'Archived already.',
			});
			projectId = project.id;
			slug = project.slug;
			await archiveSeededProject(ws, project, true);
		},
	});

	await router.navigate({ to: '/settings/archived-projects' });

	// The archived project is listed; unarchive it.
	await findByText(projectName, undefined, { timeout: 15_000 });
	await user.click(await findByTestId(`unarchive-${slug}`, undefined, { timeout: 8_000 }));

	// The backend clears archived_at, and the row drops out of the list.
	await waitFor(
		async () => {
			const row = await ctx.db.query<{ archived_at: string | null }>(
				'SELECT archived_at FROM projects WHERE id = $1',
				[projectId],
			);
			expect(row.rows[0]?.archived_at).toBeNull();
		},
		{ timeout: 8_000 },
	);
	await waitFor(() => expect(queryByTestId(`archived-project-${slug}`)).toBeNull(), {
		timeout: 8_000,
	});
});
