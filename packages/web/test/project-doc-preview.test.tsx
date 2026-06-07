import { waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import {
	type SeededProject,
	type SeededWorkspace,
	seedComment,
	seedProject,
	seedTask,
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

test('document viewer pop-out button opens the standalone preview in a new tab', async () => {
	let ctx!: { projectSlug: string };
	const { findByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Popout Demo' });
			await seedDoc(ws, project, 'ui-mockups.md', '# Mockups');
			ctx = { projectSlug: project.slug };
		},
	});

	await router.navigate({
		to: '/projects/$projectId/documents',
		params: { projectId: ctx.projectSlug },
		search: { file: 'ui-mockups.md' },
	});

	const popout = await findByTestId('doc-popout');
	const open = vi.spyOn(window, 'open').mockReturnValue(null);
	await user.click(popout);
	expect(open).toHaveBeenCalledWith(
		`/preview/${ctx.projectSlug}/ui-mockups.md`,
		'_blank',
		'noopener',
	);
	open.mockRestore();
});

test('pop-out button shows for markdown docs too, but not for the repo AGENTS.md', async () => {
	let ctx!: { projectSlug: string };
	const { findByText, queryByTestId, getByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Popout MD Demo' });
			await seedDoc(ws, project, 'notes.md', '# Hello');
			ctx = { projectSlug: project.slug };
		},
	});

	await router.navigate({
		to: '/projects/$projectId/documents',
		params: { projectId: ctx.projectSlug },
		search: { file: 'notes.md' },
	});
	await findByText('Hello');
	expect(getByTestId('doc-popout')).toBeTruthy();

	// AGENTS.md is a live repo file with no preview route — no pop-out button.
	await router.navigate({
		to: '/projects/$projectId/documents',
		params: { projectId: ctx.projectSlug },
		search: { file: '__agents_md__' },
	});
	// AGENTS.md is a live repo file with no standalone preview route, so its
	// pop-out affordance is suppressed — switching to it removes the button.
	await waitFor(() => expect(queryByTestId('doc-popout')).toBeNull());
});

test('standalone preview route renders a markdown doc without an iframe', async () => {
	let ctx!: { projectSlug: string };
	const { container, findByText, queryByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Bare MD' });
			await seedDoc(ws, project, 'notes.md', '# Hello standalone');
			ctx = { projectSlug: project.slug };
		},
	});

	await router.navigate({
		to: '/preview/$projectId/$filename',
		params: { projectId: ctx.projectSlug, filename: 'notes.md' },
	});

	await findByText('Hello standalone');
	expect(container.querySelector('iframe')).toBeNull();
	expect(queryByTestId('mobile-nav-toggle')).toBeNull();
});

test('a doc mention in a task comment gets a suffix link to the standalone preview', async () => {
	let ctx!: { projectSlug: string; taskId: string };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Mention Demo' });
			await seedDoc(ws, project, 'ui-mockups.md', '# Mockups');
			const task = await seedTask(ws, project, { title: 'Review the mockup' });
			await seedComment(ws, task, 'Please review ui-mockups.md before the demo.');
			ctx = { projectSlug: project.slug, taskId: task.id };
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: ctx.projectSlug, taskId: ctx.taskId },
	});

	// The mention resolves (doc-mention-link) and gains the new tab affordance.
	await findByTestId('text-comment-body', undefined, { timeout: 15_000 });
	const preview = await findByTestId('doc-mention-preview-link', undefined, { timeout: 15_000 });
	expect(preview.getAttribute('href')).toBe(`/preview/${ctx.projectSlug}/ui-mockups.md`);
	expect(preview.getAttribute('target')).toBe('_blank');
});
