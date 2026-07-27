import { expect, test, vi } from 'vitest';
import { renderApp } from './helpers/render';
import {
	type SeededWorkspace,
	seedComment,
	seedProject,
	seedTask,
	seedWorkspace,
} from './helpers/seed';

async function seedDoc(
	apiBase: (path: string, init: RequestInit) => Promise<Response>,
	token: string,
	projectSlug: string,
	filename: string,
	content: string,
): Promise<void> {
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
	const res = await apiBase(`/api/projects/${projectSlug}/docs/${filename}`, {
		method: 'PUT',
		headers,
		body: JSON.stringify({ content }),
	});
	if (!res.ok) throw new Error(`seed failed: ${res.status}`);
}

/**
 * Capture what the client-side download would produce: the Blob handed to
 * URL.createObjectURL and the anchor's `download` filename on click. The
 * download never leaves the page, so this is the only observable outcome.
 */
function captureDownloads(): { blobs: Blob[]; names: string[]; restore: () => void } {
	const blobs: Blob[] = [];
	const names: string[] = [];
	const origCreate = URL.createObjectURL;
	const origRevoke = URL.revokeObjectURL;
	URL.createObjectURL = vi.fn((b: Blob) => {
		blobs.push(b);
		return 'blob:mock-url';
	}) as typeof URL.createObjectURL;
	URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;
	const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
		this: HTMLAnchorElement,
	) {
		names.push(this.download);
	});
	return {
		blobs,
		names,
		restore: () => {
			clickSpy.mockRestore();
			URL.createObjectURL = origCreate;
			URL.revokeObjectURL = origRevoke;
		},
	};
}

test('downloads the open document as Markdown (lossless) and as stripped plain text', async () => {
	let ws!: SeededWorkspace;
	let projectSlug = '';
	const filename = `guide-${Math.random().toString(36).slice(2, 8)}.md`;
	const source = '# Guide\n\nRead **this** carefully before you [continue](https://example.com).';

	const { blobs, names, restore } = captureDownloads();

	try {
		const { findByTestId, user, router } = await renderApp({
			initialPath: '/',
			seed: async ({ apiBase, token }) => {
				ws = await seedWorkspace();
				const project = await seedProject(ws, {
					name: `Download Project ${Math.random().toString(36).slice(2, 8)}`,
					description: 'Tests the document download control.',
				});
				projectSlug = project.slug;
				await seedDoc(apiBase, token, projectSlug, filename, source);
			},
		});

		await router.navigate({
			to: '/projects/$projectId/documents',
			params: { projectId: projectSlug },
			search: { file: filename } as never,
		});

		// The Download control only renders once the doc content has loaded.
		const trigger = await findByTestId('doc-download', undefined, { timeout: 15_000 });

		// Markdown download → the original source, verbatim, under the .md name.
		await user.click(trigger);
		await user.click(await findByTestId('doc-download-markdown'));
		expect(names).toEqual([filename]);
		expect(blobs).toHaveLength(1);
		expect(blobs[0].type).toContain('text/markdown');
		expect(await blobs[0].text()).toBe(source);

		// Plain-text download → Markdown stripped, under the .txt name.
		await user.click(trigger);
		await user.click(await findByTestId('doc-download-text'));
		expect(names).toEqual([filename, filename.replace(/\.md$/, '.txt')]);
		expect(blobs).toHaveLength(2);
		expect(blobs[1].type).toContain('text/plain');
		expect(await blobs[1].text()).toBe('Guide\n\nRead this carefully before you continue.');
	} finally {
		restore();
	}
});

// The task-sidebar preview panel is a full read surface for a document, so it
// carries the same download control as the Documents toolbar — reading a doc
// from the task thread shouldn't force a detour through another page to save it.
test('downloads the document from the task-sidebar preview panel', async () => {
	let ctx!: { projectSlug: string; taskId: string };
	const source = '# Mockups\n\nThe **hero** section needs a [rework](https://example.com).';

	const { blobs, names, restore } = captureDownloads();

	try {
		const { findByTestId, user, router } = await renderApp({
			initialPath: '/',
			seed: async ({ apiBase, token }) => {
				const ws = await seedWorkspace();
				const project = await seedProject(ws, { name: 'Panel Download Demo' });
				await seedDoc(apiBase, token, project.slug, 'ui-mockups.md', source);
				const task = await seedTask(ws, project, { title: 'Review the mockup' });
				await seedComment(ws, task, 'Please review ui-mockups.md before the demo.');
				ctx = { projectSlug: project.slug, taskId: task.id };
			},
		});

		await router.navigate({
			to: '/projects/$projectId/tasks/$taskId',
			params: { projectId: ctx.projectSlug, taskId: ctx.taskId },
		});

		// The panel opens from the doc mention in the comment.
		const mention = await findByTestId('doc-mention-link', undefined, { timeout: 15_000 });
		await user.click(mention);
		await findByTestId('preview-panel');

		// The control renders only once the panel's doc query has resolved.
		const trigger = await findByTestId('doc-download', undefined, { timeout: 15_000 });
		await user.click(trigger);
		await user.click(await findByTestId('doc-download-markdown'));
		expect(names).toEqual(['ui-mockups.md']);
		expect(await blobs[0].text()).toBe(source);

		await user.click(trigger);
		await user.click(await findByTestId('doc-download-text'));
		expect(names).toEqual(['ui-mockups.md', 'ui-mockups.txt']);
		expect(blobs[1].type).toContain('text/plain');
		expect(await blobs[1].text()).toBe('Mockups\n\nThe hero section needs a rework.');
	} finally {
		restore();
	}
});

// The standalone preview route (the doc's "open in new tab") is the other read
// surface, and the one most likely to be where a doc is read in full.
test('downloads the document from the standalone preview tab', async () => {
	let ctx!: { projectSlug: string };
	const source = '# Notes\n\nA line with **emphasis**.';

	const { blobs, names, restore } = captureDownloads();

	try {
		const { findByTestId, findByText, user, router } = await renderApp({
			initialPath: '/',
			seed: async ({ apiBase, token }) => {
				const ws = await seedWorkspace();
				const project = await seedProject(ws, { name: 'Tab Download Demo' });
				await seedDoc(apiBase, token, project.slug, 'notes.md', source);
				ctx = { projectSlug: project.slug };
			},
		});

		await router.navigate({
			to: '/preview/$projectId/$filename',
			params: { projectId: ctx.projectSlug, filename: 'notes.md' },
		});
		await findByText('Notes');

		const trigger = await findByTestId('doc-download', undefined, { timeout: 15_000 });
		await user.click(trigger);
		await user.click(await findByTestId('doc-download-markdown'));
		expect(names).toEqual(['notes.md']);
		expect(await blobs[0].text()).toBe(source);

		await user.click(trigger);
		await user.click(await findByTestId('doc-download-text'));
		expect(names).toEqual(['notes.md', 'notes.txt']);
		expect(await blobs[1].text()).toBe('Notes\n\nA line with emphasis.');
	} finally {
		restore();
	}
});
