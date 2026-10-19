import { queryClient } from '@hezo/web/lib/query-client';
import { queryKeys } from '@hezo/web/lib/query-keys';
import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { type SeededWorkspace, seedProject, seedWorkspace } from './helpers/seed';

// Renaming a project rewrites its slug, and the server resolves only the
// current one. The project layout follows the project to its new slug - from
// the settings page's own save, or from a rename made elsewhere once the
// projects index refetches - so the reader is never left on a dead address.

async function slugOf(projectId: string): Promise<string> {
	const { db } = getTestContext();
	const res = await db.query<{ slug: string }>('SELECT slug FROM projects WHERE id = $1', [
		projectId,
	]);
	return res.rows[0].slug;
}

test('saving a new name on the settings page moves the page to the new slug', async () => {
	let project = { id: '', slug: '' };
	const { findByRole, findByLabelText, findByText, getByRole, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			project = await seedProject(await seedWorkspace(), { name: 'Alpha' });
		},
	});
	await router.navigate({
		to: '/projects/$projectId/settings',
		params: { projectId: project.slug },
	});

	await user.click(await findByRole('button', { name: 'Edit' }, { timeout: 15_000 }));
	const name = (await findByLabelText('Name')) as HTMLInputElement;
	await user.clear(name);
	await user.type(name, 'Gamma');
	await user.click(getByRole('button', { name: 'Save' }));

	const renamed = await waitFor(async () => {
		const slug = await slugOf(project.id);
		expect(slug).not.toBe(project.slug);
		return slug;
	});
	await waitFor(() => expect(router.state.location.pathname).toBe(`/projects/${renamed}/settings`));
	await findByText('Gamma');
});

test('a rename made elsewhere moves the page once the projects index refetches', async () => {
	let ws!: SeededWorkspace;
	let project = { id: '', slug: '' };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			project = await seedProject(ws, { name: 'Alpha' });
		},
	});
	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: project.slug },
		search: { status: 'open' } as never,
	});
	await findByTestId('project-sidebar-chat', undefined, { timeout: 15_000 });

	// Another tab renames the project. The server's broadcast reaches this tab as
	// an index invalidation; the harness stubs WebSocket, so invalidate directly.
	const renamed = (await seedProject(ws, { name: 'Delta' })).slug;
	await queryClient.invalidateQueries({ queryKey: queryKeys.projects.all(), exact: true });

	await waitFor(() => expect(router.state.location.pathname).toBe(`/projects/${renamed}/tasks`));
	expect(router.state.location.search).toEqual({ status: 'open' });
});

test('an unknown project slug stays put rather than jumping to the project before it', async () => {
	let project = { id: '', slug: '' };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			project = await seedProject(await seedWorkspace(), { name: 'Alpha' });
		},
	});
	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: project.slug },
	});
	await findByTestId('project-sidebar-chat', undefined, { timeout: 15_000 });

	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: 'not-a-project' },
	});
	await queryClient.invalidateQueries({ queryKey: queryKeys.projects.all(), exact: true });
	await queryClient.refetchQueries({ queryKey: queryKeys.projects.all(), exact: true });

	expect(router.state.location.pathname).toBe('/projects/not-a-project/tasks');
});
