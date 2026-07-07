import { waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import {
	archiveSeededDocument,
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

test('standalone preview route flags an archived doc in the metadata banner', async () => {
	let ctx!: { projectSlug: string };
	const { findByText, findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Archived Bare' });
			await seedDoc(ws, project, 'old-notes.md', '# Retired notes');
			await archiveSeededDocument(ws, project, 'old-notes.md');
			ctx = { projectSlug: project.slug };
		},
	});

	await router.navigate({
		to: '/preview/$projectId/$filename',
		params: { projectId: ctx.projectSlug, filename: 'old-notes.md' },
	});

	await findByText('Retired notes');
	const banner = await findByTestId('doc-metadata-banner');
	expect(banner.textContent).toContain('Archived');
});

test('standalone preview route shows no archived flag for an active doc', async () => {
	let ctx!: { projectSlug: string };
	const { findByText, findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Active Bare' });
			await seedDoc(ws, project, 'live-notes.md', '# Live notes');
			ctx = { projectSlug: project.slug };
		},
	});

	await router.navigate({
		to: '/preview/$projectId/$filename',
		params: { projectId: ctx.projectSlug, filename: 'live-notes.md' },
	});

	await findByText('Live notes');
	const banner = await findByTestId('doc-metadata-banner');
	expect(banner.textContent).not.toContain('Archived');
});

test('the task-detail preview panel flags an archived doc in the metadata banner', async () => {
	let ctx!: { projectSlug: string; taskId: string };
	const { findByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Panel Archive Demo' });
			await seedDoc(ws, project, 'ui-mockups.md', '# Mockups');
			await archiveSeededDocument(ws, project, 'ui-mockups.md');
			const task = await seedTask(ws, project, { title: 'Review the mockup' });
			await seedComment(ws, task, 'Please review ui-mockups.md before the demo.');
			ctx = { projectSlug: project.slug, taskId: task.id };
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: ctx.projectSlug, taskId: ctx.taskId },
	});

	const mention = await findByTestId('doc-mention-link', undefined, { timeout: 15_000 });
	await user.click(mention);
	const banner = await findByTestId('doc-metadata-banner');
	expect(banner.textContent).toContain('Archived');
});

test('standalone preview route exposes Edit and History deep-links into the documents editor', async () => {
	let ctx!: { projectSlug: string };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Preview Actions' });
			await seedDoc(ws, project, 'notes.md', '# Hello standalone');
			ctx = { projectSlug: project.slug };
		},
	});

	await router.navigate({
		to: '/preview/$projectId/$filename',
		params: { projectId: ctx.projectSlug, filename: 'notes.md' },
	});

	const editLink = (await findByTestId('preview-edit')) as HTMLAnchorElement;
	const historyLink = (await findByTestId('preview-history')) as HTMLAnchorElement;
	// Both point back at the authoritative Documents surface for this file — Edit
	// opens it in edit mode, History opens the revision dialog.
	expect(editLink.getAttribute('href')).toContain(`/projects/${ctx.projectSlug}/documents`);
	expect(editLink.getAttribute('href')).toContain('file=notes.md');
	expect(editLink.getAttribute('href')).toContain('edit');
	expect(historyLink.getAttribute('href')).toContain('file=notes.md');
	expect(historyLink.getAttribute('href')).toContain('history');
});

test('standalone preview hides Edit for an archived doc but keeps History', async () => {
	let ctx!: { projectSlug: string };
	const { findByTestId, queryByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Archived Actions' });
			await seedDoc(ws, project, 'retired.md', '# Retired');
			await archiveSeededDocument(ws, project, 'retired.md');
			ctx = { projectSlug: project.slug };
		},
	});

	await router.navigate({
		to: '/preview/$projectId/$filename',
		params: { projectId: ctx.projectSlug, filename: 'retired.md' },
	});

	// History stays reachable on an archived doc (revisions remain viewable); the
	// Edit affordance is suppressed since an archived doc is read-only.
	await findByTestId('preview-history');
	expect(queryByTestId('preview-edit')).toBeNull();
});

test('the task-detail preview panel exposes Edit and History deep-links into the documents editor', async () => {
	let ctx!: { projectSlug: string; taskId: string };
	const { findByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Panel Actions Demo' });
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

	const mention = await findByTestId('doc-mention-link', undefined, { timeout: 15_000 });
	await user.click(mention);

	const editLink = (await findByTestId('preview-edit')) as HTMLAnchorElement;
	const historyLink = (await findByTestId('preview-history')) as HTMLAnchorElement;
	expect(editLink.getAttribute('href')).toContain(`/projects/${ctx.projectSlug}/documents`);
	expect(editLink.getAttribute('href')).toContain('file=ui-mockups.md');
	expect(editLink.getAttribute('href')).toContain('edit');
	expect(historyLink.getAttribute('href')).toContain('history');
});

test('a doc mention in a task comment opens the preview panel instead of a new tab', async () => {
	let ctx!: { projectSlug: string; taskId: string };
	const { container, findByTestId, user, router } = await renderApp({
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

	// In a task comment the mention is a button that opens the in-page panel —
	// no trailing new-tab suffix link.
	const name = await findByTestId('doc-mention-link', undefined, { timeout: 15_000 });
	expect(name.tagName).toBe('BUTTON');
	expect(container.querySelector('[data-testid="doc-mention-preview-link"]')).toBeNull();

	// The new-tab affordance now lives on the panel and points at the standalone preview.
	await user.click(name);
	const openTab = (await findByTestId('preview-open-tab')) as HTMLAnchorElement;
	expect(openTab.getAttribute('href')).toBe(`/preview/${ctx.projectSlug}/ui-mockups.md`);
	expect(openTab.getAttribute('target')).toBe('_blank');
});
