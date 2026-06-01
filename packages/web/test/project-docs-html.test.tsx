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
	await apiBase(`/api/teams/${ws.team.id}/projects/${project.slug}/docs/${filename}`, {
		method: 'PUT',
		headers: ws.headers,
		body: JSON.stringify({ content }),
	});
}

const HTML_BODY =
	'<!DOCTYPE html><html><head><style>h1{color:red}</style></head><body><h1>Mockup heading</h1></body></html>';

test('renders an .html project doc in a sandboxed preview iframe with a source toggle', async () => {
	let ctx!: { teamSlug: string; projectSlug: string };
	const { container, findByText, getByText, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Docs Demo' });
			await seedDoc(ws, project, 'ui-mockups.html', HTML_BODY);
			ctx = { teamSlug: ws.team.slug, projectSlug: project.slug };
		},
	});

	await router.navigate({
		to: '/teams/$teamId/projects/$projectId/documents',
		params: { teamId: ctx.teamSlug, projectId: ctx.projectSlug },
		search: { file: 'ui-mockups.html' },
	});

	// Preview is the default: a sandboxed iframe carrying the doc in srcDoc.
	await findByText('ui-mockups.html');
	const iframe = await waitForIframe(container);
	expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
	expect(iframe.getAttribute('srcdoc')).toContain('Mockup heading');

	// Flipping to Source swaps the iframe for the raw HTML text.
	await user.click(getByText('source'));
	await findByText(HTML_BODY, { exact: false });
	expect(container.querySelector('iframe')).toBeNull();
});

test('renders an .md project doc as markdown, not an iframe', async () => {
	let ctx!: { teamSlug: string; projectSlug: string };
	const { container, findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Docs Demo MD' });
			await seedDoc(ws, project, 'notes.md', '# Hello markdown');
			ctx = { teamSlug: ws.team.slug, projectSlug: project.slug };
		},
	});

	await router.navigate({
		to: '/teams/$teamId/projects/$projectId/documents',
		params: { teamId: ctx.teamSlug, projectId: ctx.projectSlug },
		search: { file: 'notes.md' },
	});

	await findByText('Hello markdown');
	expect(container.querySelector('iframe')).toBeNull();
});

async function waitForIframe(container: HTMLElement): Promise<HTMLIFrameElement> {
	for (let i = 0; i < 50; i++) {
		const el = container.querySelector('iframe');
		if (el) return el as HTMLIFrameElement;
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error('iframe never appeared');
}
