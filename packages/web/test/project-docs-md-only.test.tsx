import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import {
	type SeededProject,
	type SeededWorkspace,
	seedProject,
	seedWorkspace,
} from './helpers/seed';

async function seedDoc(
	ws: SeededWorkspace,
	project: SeededProject,
	filename: string,
	content: string,
): Promise<void> {
	const { apiBase } = getTestContext();
	await apiBase(`/api/projects/${project.slug}/docs/${filename}`, {
		method: 'PUT',
		headers: ws.headers,
		body: JSON.stringify({ content }),
	});
}

test('the New Document form rejects non-markdown filenames', async () => {
	let ctx!: { projectSlug: string };
	const { findByText, findByPlaceholderText, getByRole, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'MD Only' });
			ctx = { projectSlug: project.slug };
		},
	});

	await router.navigate({
		to: '/projects/$projectId/documents',
		params: { projectId: ctx.projectSlug },
	});

	await user.click(await findByText('New document'));
	await user.type(await findByPlaceholderText('notes.md'), 'mockup.html');
	await user.click(getByRole('button', { name: 'Create' }));

	await findByText(/must end with \.md/i);
});

test('a markdown project doc renders as markdown, not an iframe', async () => {
	let ctx!: { projectSlug: string };
	const { container, findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'MD Render' });
			await seedDoc(ws, project, 'notes.md', '# Hello markdown');
			ctx = { projectSlug: project.slug };
		},
	});

	await router.navigate({
		to: '/projects/$projectId/documents',
		params: { projectId: ctx.projectSlug },
		search: { file: 'notes.md' },
	});

	await findByText('Hello markdown');
	expect(container.querySelector('iframe')).toBeNull();
});
