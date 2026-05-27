import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { type SeededWorkspace, seedProject, seedWorkspace } from './helpers/seed';

function uniqueName(base: string): string {
	return `${base} ${Math.random().toString(36).slice(2, 8)}`;
}

test('can create, view, edit, and delete a project document', async () => {
	let ws!: SeededWorkspace;
	let projectSlug = '';

	const {
		container,
		findByRole,
		findByLabelText,
		findByTestId,
		findByText,
		queryByText,
		user,
		router,
	} = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			const project = await seedProject(ws, {
				name: uniqueName('Docs Test Project'),
				description: 'Project for testing the documents tab.',
			});
			projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/projects/$projectId/documents',
		params: { teamId: ws.team.slug, projectId: projectSlug },
	});

	const filename = `notes-${Math.random().toString(36).slice(2, 8)}.md`;

	await user.click(await findByRole('button', { name: 'New document' }));

	await user.type(await findByLabelText('Filename'), filename);
	const contentArea = container.querySelector('textarea') as HTMLTextAreaElement;
	expect(contentArea).toBeTruthy();
	await user.type(contentArea, '# Project Notes\n\nSome **markdown** content.');

	await user.click(await findByRole('button', { name: 'Create' }));

	// Doc title in viewer header.
	await findByRole('heading', { name: filename, level: 2 }, { timeout: 15_000 });
	await findByText('Project Notes', undefined, { timeout: 15_000 });

	// Edit content.
	await user.click(await findByRole('button', { name: 'Edit' }));
	const editArea = container.querySelector('textarea') as HTMLTextAreaElement;
	await user.clear(editArea);
	await user.type(editArea, 'Updated content for the doc');
	await user.click(await findByRole('button', { name: 'Save' }));

	await findByText('Updated content for the doc', undefined, { timeout: 15_000 });

	// Delete via the confirm dialog.
	await user.click(await findByRole('button', { name: 'Delete document' }));
	await user.click(await findByTestId('confirm-dialog-confirm'));

	// After deletion, the doc list entry is gone.
	await new Promise((r) => setTimeout(r, 200));
	expect(queryByText(filename)).toBeNull();
});

test('shows revision history and restores a previous version', async () => {
	let ws!: SeededWorkspace;
	let projectSlug = '';
	const filename = `plan-${Math.random().toString(36).slice(2, 8)}.md`;

	const { findByText, findByTestId, findByRole, user, router } = await renderApp({
		initialPath: '/',
		seed: async ({ apiBase, token }) => {
			ws = await seedWorkspace();
			const project = await seedProject(ws, {
				name: uniqueName('Revision Project'),
				description: 'Project for testing project doc revisions.',
			});
			projectSlug = project.slug;

			const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
			const docPath = `/api/teams/${ws.team.id}/projects/${project.slug}/docs/${filename}`;
			const create = await apiBase(docPath, {
				method: 'PUT',
				headers,
				body: JSON.stringify({ content: 'Original plan' }),
			});
			if (!create.ok) throw new Error(`create failed: ${create.status}`);
			const update = await apiBase(docPath, {
				method: 'PUT',
				headers,
				body: JSON.stringify({ content: 'Second draft' }),
			});
			if (!update.ok) throw new Error(`update failed: ${update.status}`);
		},
	});

	await router.navigate({
		to: '/teams/$teamId/projects/$projectId/documents',
		params: { teamId: ws.team.slug, projectId: projectSlug },
		search: { file: filename } as never,
	});

	await findByText('Second draft', undefined, { timeout: 15_000 });

	await user.click(await findByRole('button', { name: /show revision history/i }));

	await findByText(/Rev 1/, undefined, { timeout: 15_000 });

	const restoreButtons = await findByRole('button', { name: /restore/i });
	await user.click(restoreButtons);

	await user.click(await findByTestId('confirm-dialog-confirm'));

	await findByText('Original plan', undefined, { timeout: 15_000 });
});

test('rejects invalid filename when creating a document', async () => {
	let ws!: SeededWorkspace;
	let projectSlug = '';

	const { container, findByRole, findByLabelText, findByText, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			const project = await seedProject(ws, {
				name: uniqueName('Filename Test'),
				description: 'Tests filename validation.',
			});
			projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/projects/$projectId/documents',
		params: { teamId: ws.team.slug, projectId: projectSlug },
	});

	await user.click(await findByRole('button', { name: 'New document' }));
	await user.type(await findByLabelText('Filename'), 'not-markdown');
	const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
	await user.type(textarea, 'content');
	await user.click(await findByRole('button', { name: 'Create' }));

	await findByText(/Filename must end with \.md/, undefined, { timeout: 10_000 });
});
