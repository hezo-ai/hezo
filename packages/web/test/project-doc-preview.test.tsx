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
	await apiBase(`/api/teams/${ws.team.id}/projects/${project.slug}/docs/${filename}`, {
		method: 'PUT',
		headers: ws.headers,
		body: JSON.stringify({ content }),
	});
}

const HTML_BODY =
	'<!DOCTYPE html><html><head><style>h1{color:red}</style></head><body><h1>Mockup heading</h1></body></html>';

async function waitForIframe(container: HTMLElement): Promise<HTMLIFrameElement> {
	for (let i = 0; i < 50; i++) {
		const el = container.querySelector('iframe');
		if (el) return el as HTMLIFrameElement;
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error('iframe never appeared');
}

test('document viewer pop-out button opens the standalone preview in a new tab', async () => {
	let ctx!: { teamSlug: string; projectSlug: string };
	const { findByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Popout Demo' });
			await seedDoc(ws, project, 'ui-mockups.html', HTML_BODY);
			ctx = { teamSlug: ws.team.slug, projectSlug: project.slug };
		},
	});

	await router.navigate({
		to: '/teams/$teamId/projects/$projectId/documents',
		params: { teamId: ctx.teamSlug, projectId: ctx.projectSlug },
		search: { file: 'ui-mockups.html' },
	});

	const popout = await findByTestId('doc-popout');
	const open = vi.spyOn(window, 'open').mockReturnValue(null);
	await user.click(popout);
	expect(open).toHaveBeenCalledWith(
		`/preview/${ctx.teamSlug}/${ctx.projectSlug}/ui-mockups.html`,
		'_blank',
		'noopener',
	);
	open.mockRestore();
});

test('pop-out button shows for markdown docs too, but not for the repo AGENTS.md', async () => {
	let ctx!: { teamSlug: string; projectSlug: string };
	const { findByText, queryByTestId, getByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Popout MD Demo' });
			await seedDoc(ws, project, 'notes.md', '# Hello');
			ctx = { teamSlug: ws.team.slug, projectSlug: project.slug };
		},
	});

	await router.navigate({
		to: '/teams/$teamId/projects/$projectId/documents',
		params: { teamId: ctx.teamSlug, projectId: ctx.projectSlug },
		search: { file: 'notes.md' },
	});
	await findByText('Hello');
	expect(getByTestId('doc-popout')).toBeTruthy();

	// AGENTS.md is a live repo file with no preview route — no pop-out button.
	await router.navigate({
		to: '/teams/$teamId/projects/$projectId/documents',
		params: { teamId: ctx.teamSlug, projectId: ctx.projectSlug },
		search: { file: '__agents_md__' },
	});
	await findByText('AGENTS.md');
	expect(queryByTestId('doc-popout')).toBeNull();
});

test('standalone preview route renders an HTML doc full-page with no app chrome', async () => {
	let ctx!: { teamSlug: string; projectSlug: string };
	const { container, queryByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Bare HTML' });
			await seedDoc(ws, project, 'ui-mockups.html', HTML_BODY);
			ctx = { teamSlug: ws.team.slug, projectSlug: project.slug };
		},
	});

	await router.navigate({
		to: '/preview/$teamId/$projectId/$filename',
		params: {
			teamId: ctx.teamSlug,
			projectId: ctx.projectSlug,
			filename: 'ui-mockups.html',
		},
	});

	const iframe = await waitForIframe(container);
	expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
	expect(iframe.getAttribute('srcdoc')).toContain('Mockup heading');
	expect(iframe.className).toContain('h-screen');
	// No team rail / sidebar / mobile drawer toggle in bare mode.
	expect(queryByTestId('sidebar-toggle')).toBeNull();
	expect(queryByTestId('mobile-nav-toggle')).toBeNull();
});

test('standalone preview route renders a markdown doc without an iframe', async () => {
	let ctx!: { teamSlug: string; projectSlug: string };
	const { container, findByText, queryByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Bare MD' });
			await seedDoc(ws, project, 'notes.md', '# Hello standalone');
			ctx = { teamSlug: ws.team.slug, projectSlug: project.slug };
		},
	});

	await router.navigate({
		to: '/preview/$teamId/$projectId/$filename',
		params: { teamId: ctx.teamSlug, projectId: ctx.projectSlug, filename: 'notes.md' },
	});

	await findByText('Hello standalone');
	expect(container.querySelector('iframe')).toBeNull();
	expect(queryByTestId('mobile-nav-toggle')).toBeNull();
});

test('a doc mention in a task comment gets a suffix link to the standalone preview', async () => {
	let ctx!: { teamSlug: string; projectSlug: string; taskId: string };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Mention Demo' });
			await seedDoc(ws, project, 'ui-mockups.html', HTML_BODY);
			const task = await seedTask(ws, project, { title: 'Review the mockup' });
			await seedComment(ws, task, 'Please review ui-mockups.html before the demo.');
			ctx = { teamSlug: ws.team.slug, projectSlug: project.slug, taskId: task.id };
		},
	});

	await router.navigate({
		to: '/teams/$teamId/tasks/$taskId',
		params: { teamId: ctx.teamSlug, taskId: ctx.taskId },
	});

	// The mention resolves (doc-mention-link) and gains the new tab affordance.
	await findByTestId('text-comment-body', undefined, { timeout: 15_000 });
	const preview = await findByTestId('doc-mention-preview-link', undefined, { timeout: 15_000 });
	expect(preview.getAttribute('href')).toBe(
		`/preview/${ctx.teamSlug}/${ctx.projectSlug}/ui-mockups.html`,
	);
	expect(preview.getAttribute('target')).toBe('_blank');
});
