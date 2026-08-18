import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedAsset, seedComment, seedProject, seedTask, seedWorkspace } from './helpers/seed';

test('an asset card opens the in-app viewer, with a raw new-tab popout beside it', async () => {
	let ctx!: { projectSlug: string };
	const { findByText, findByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Asset Lib' });
			await seedAsset(ws, project, { filename: 'mockup.png' });
			ctx = { projectSlug: project.slug };
		},
	});

	await router.navigate({
		to: '/projects/$projectId/assets',
		params: { projectId: ctx.projectSlug },
	});

	await findByText('mockup.png');
	// The corner popout keeps raw new-tab access to the signed URL.
	const popout = await findByTestId('asset-popout');
	expect(popout.getAttribute('href')).toMatch(/^\/api\/assets\/[0-9a-f-]+\?exp=\d+&sig=/);
	expect(popout.getAttribute('target')).toBe('_blank');

	// The card media navigates to the viewer.
	await user.click(await findByTestId('asset-open-viewer'));
	await findByTestId('asset-viewer');
	expect(router.state.location.pathname).toBe(`/projects/${ctx.projectSlug}/assets/view`);
	expect(router.state.location.search).toMatchObject({ file: 'mockup.png' });
	await findByTestId('asset-viewer-image');
});

test('a markdown asset opens in the viewer with a view-source toggle', async () => {
	let ctx!: { projectSlug: string };
	const md = '# Launch Post\n\nWe shipped **markdown assets**.';
	const { findByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Blog' });
			await seedAsset(ws, project, {
				filename: 'post.md',
				contentType: 'text/markdown',
				bytes: new TextEncoder().encode(md),
			});
			ctx = { projectSlug: project.slug };
		},
	});

	await router.navigate({
		to: '/projects/$projectId/assets',
		params: { projectId: ctx.projectSlug },
	});

	// The card navigates to the in-app viewer.
	await user.click(await findByTestId('asset-open-viewer'));

	// Preview renders the markdown — the heading becomes an <h1>, not a literal `#`.
	const rendered = await findByTestId('asset-viewer-rendered');
	await waitFor(() => expect(rendered.querySelector('h1')?.textContent).toBe('Launch Post'));

	// Flipping to Source shows the raw markdown verbatim (the `#`, the `**`).
	await user.click(await findByTestId('asset-viewer-source-tab'));
	const source = await findByTestId('asset-viewer-source');
	expect(source.textContent).toBe(md);
});

test('a markdown asset card shows a rendered-text thumbnail instead of a file glyph', async () => {
	let ctx!: { projectSlug: string };
	const md = '# Launch Post\n\nWe shipped **markdown assets**.';
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Blog' });
			await seedAsset(ws, project, {
				filename: 'post.md',
				contentType: 'text/markdown',
				bytes: new TextEncoder().encode(md),
			});
			ctx = { projectSlug: project.slug };
		},
	});

	await router.navigate({
		to: '/projects/$projectId/assets',
		params: { projectId: ctx.projectSlug },
	});

	// The thumbnail renders the markdown — the heading becomes an <h1> in the
	// card media, not a literal `#` or a generic document icon.
	const thumb = await findByTestId('asset-markdown-thumbnail');
	await waitFor(() => expect(thumb.querySelector('h1')?.textContent).toBe('Launch Post'));
	expect(thumb.querySelector('strong')?.textContent).toBe('markdown assets');
});

test('a CSV asset card shows a mini table thumbnail instead of a file glyph', async () => {
	let ctx!: { projectSlug: string };
	const csv = 'url,reply_text,priority\nhttps://x.com/a/1,"Ownership, not vibes.",high';
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Replies' });
			await seedAsset(ws, project, {
				filename: 'x-replies.csv',
				contentType: 'text/plain',
				bytes: new TextEncoder().encode(csv),
			});
			ctx = { projectSlug: project.slug };
		},
	});

	await router.navigate({
		to: '/projects/$projectId/assets',
		params: { projectId: ctx.projectSlug },
	});

	// The card media reads as a grid: real header cells, and a quoted value
	// resolved into one cell rather than shown with its quotes.
	const thumb = await findByTestId('asset-csv-thumbnail');
	await waitFor(() =>
		expect(Array.from(thumb.querySelectorAll('th')).map((th) => th.textContent)).toEqual([
			'url',
			'reply_text',
			'priority',
		]),
	);
	expect(Array.from(thumb.querySelectorAll('td')).map((td) => td.textContent)).toEqual([
		'https://x.com/a/1',
		'Ownership, not vibes.',
		'high',
	]);
});

test('an asset is archived first, then deleted from the Archived view', async () => {
	let ctx!: { projectSlug: string };
	const { findByText, findByTestId, getByRole, queryByText, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Deletable' });
			await seedAsset(ws, project, { filename: 'remove-me.png' });
			ctx = { projectSlug: project.slug };
		},
	});

	await router.navigate({
		to: '/projects/$projectId/assets',
		params: { projectId: ctx.projectSlug },
	});

	// Active cards offer the reversible Archive, not Delete — archiving drops
	// the asset from the default Active view.
	await findByText('remove-me.png');
	await user.click(await findByTestId('asset-archive'));
	await waitFor(() => expect(queryByText('remove-me.png')).toBeNull());

	// Switch to the Archived view through the funnel popover.
	await user.click(await findByTestId('asset-filter-button'));
	await user.click(await findByTestId('asset-filter-option-archived'));
	await findByText('remove-me.png');

	// The hard delete lives on archived cards; ConfirmDialog is a portal.
	await user.click(await findByTestId('asset-delete'));
	await user.click(getByRole('button', { name: 'Delete' }));

	await waitFor(() => expect(queryByText('remove-me.png')).toBeNull());
});

test('an assets/<name> reference in a task comment links to the in-app asset viewer', async () => {
	let ctx!: { projectSlug: string; taskId: string };
	const { container, findByTestId, queryByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Mention Assets' });
			await seedAsset(ws, project, { filename: 'login.png' });
			const task = await seedTask(ws, project, { title: 'Build the login screen' });
			await seedComment(ws, task, 'Match the layout to assets/login.png before you start.');
			ctx = { projectSlug: project.slug, taskId: task.id };
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: ctx.projectSlug, taskId: ctx.taskId },
	});

	// The asset mention is a same-tab router link into the asset viewer (the
	// canonical asset link target — raw view lives in the viewer's toolbar).
	const link = (await findByTestId('asset-mention-link', undefined, {
		timeout: 15_000,
	})) as HTMLAnchorElement;
	expect(link.tagName).toBe('A');
	expect(link.textContent).toContain('assets/login.png');
	expect(link.getAttribute('target')).toBeNull();
	expect(link.getAttribute('href')).toBe(`/projects/${ctx.projectSlug}/assets/view?file=login.png`);

	// Same-tab in-app mentions carry no new-tab icon.
	expect(queryByTestId('asset-mention-preview-link')).toBeNull();

	// Assets never route through the in-page preview panel.
	expect(container.querySelector('[data-testid="preview-panel"]')).toBeNull();
});

test('a foldered assets/<folder>/<name> reference links; an over-deep path stays plain text', async () => {
	let ctx!: { projectSlug: string; taskId: string };
	const { findByTestId, findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Foldered Mentions' });
			await seedAsset(ws, project, { filename: 'hero.png', folder: 'blog/images' });
			const task = await seedTask(ws, project, { title: 'Write the post' });
			await seedComment(
				ws,
				task,
				'Use assets/blog/images/hero.png but never assets/a/b/c/d.png anywhere.',
			);
			ctx = { projectSlug: project.slug, taskId: task.id };
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: ctx.projectSlug, taskId: ctx.taskId },
	});

	// The 2-level path resolves and links into the asset viewer.
	const link = (await findByTestId('asset-mention-link', undefined, {
		timeout: 15_000,
	})) as HTMLAnchorElement;
	expect(link.textContent).toContain('assets/blog/images/hero.png');
	expect(link.getAttribute('href')).toMatch(
		/^\/projects\/[^/]+\/assets\/view\?file=blog(%2F|\/)images(%2F|\/)hero\.png$/,
	);

	// The 3-level path never parses as an asset reference — plain prose text
	// (the valid mention contributes its link anchor; none of the anchors carry
	// the over-deep path).
	const comment = await findByText(/never assets\/a\/b\/c\/d\.png anywhere/);
	const anchors = Array.from(comment.querySelectorAll('a'));
	expect(anchors.length).toBeGreaterThan(0);
	expect(anchors.some((a) => a.textContent?.includes('a/b/c/d.png'))).toBe(false);
});

test('the copy-link button copies the asset reference (assets/<path>) to the clipboard', async () => {
	let ctx!: { projectSlug: string };
	const { findByText, findByTestId, router, user } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Refs' });
			await seedAsset(ws, project, { filename: 'hero.png', folder: 'blog/images' });
			ctx = { projectSlug: project.slug };
		},
	});

	await router.navigate({
		to: '/projects/$projectId/assets',
		params: { projectId: ctx.projectSlug },
		search: { folder: 'blog/images' },
	});
	await findByText('hero.png');

	const writes: string[] = [];
	const originalDesc = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
	Object.defineProperty(navigator, 'clipboard', {
		configurable: true,
		value: {
			writeText: async (t: string) => {
				writes.push(t);
			},
		},
	});
	try {
		const copyBtn = await findByTestId('asset-copy-link');
		expect(copyBtn.getAttribute('aria-label')).toBe('Copy reference link');
		await user.click(copyBtn);
		// The full foldered path is included so the copied string linkifies verbatim
		// in a comment or doc.
		expect(writes).toEqual(['assets/blog/images/hero.png']);
		// The icon swaps to a check — the aria-label flips to "Reference copied".
		await waitFor(() => expect(copyBtn.getAttribute('aria-label')).toBe('Reference copied'));
	} finally {
		if (originalDesc) Object.defineProperty(navigator, 'clipboard', originalDesc);
		else delete (navigator as { clipboard?: unknown }).clipboard;
	}
});

test('uploading a file through the picker adds it to the library', async () => {
	let ctx!: { projectSlug: string };
	const { findByText, findByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Upload Lib' });
			ctx = { projectSlug: project.slug };
		},
	});

	await router.navigate({
		to: '/projects/$projectId/assets',
		params: { projectId: ctx.projectSlug },
	});

	await findByText('No assets yet');
	const input = await findByTestId('asset-file-input');
	const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], 'diagram.png', {
		type: 'image/png',
	});
	await user.upload(input as HTMLInputElement, file);

	await findByText('diagram.png');
});
