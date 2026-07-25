import { expect, test, vi } from 'vitest';
import { renderApp } from './helpers/render';
import { type SeededWorkspace, seedProject, seedWorkspace } from './helpers/seed';

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

test('downloads the open document as Markdown (lossless) and as stripped plain text', async () => {
	let ws!: SeededWorkspace;
	let projectSlug = '';
	const filename = `guide-${Math.random().toString(36).slice(2, 8)}.md`;
	const source = '# Guide\n\nRead **this** carefully before you [continue](https://example.com).';

	// Capture what the client-side download would produce: the Blob handed to
	// URL.createObjectURL and the anchor's `download` filename on click.
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
		clickSpy.mockRestore();
		URL.createObjectURL = origCreate;
		URL.revokeObjectURL = origRevoke;
	}
});
