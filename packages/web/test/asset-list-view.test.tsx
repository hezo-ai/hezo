// The Assets page's list view: the Grid/List toggle and its `view` URL param,
// the columns the list adds (type token, size, modified), folders leading the
// rows, sortable column headers driving the same `?sort` the toolbar control
// shows, and an archived row swapping its actions. Component tier — the mobile
// column collapse and the filter dialog need a real viewport and live in
// `test/browser/asset-list-view.mobile.spec.ts`.

import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import {
	archiveSeededAsset,
	type SeededWorkspace,
	seedAsset,
	seedProject,
	seedWorkspace,
} from './helpers/seed';

async function setup() {
	let ws!: SeededWorkspace;
	const ref = { slug: '' };
	const helpers = await renderApp({
		initialPath: '/',
		seed: async (ctx) => {
			ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Listable Assets' });
			ref.slug = project.slug;
			// Extensions, sizes and dates all differ so no two orders coincide.
			const rows = await seedAsset(ws, project, {
				filename: 'rows.csv',
				contentType: 'text/plain',
				bytes: new Uint8Array(4096),
			});
			const notes = await seedAsset(ws, project, {
				filename: 'notes.md',
				contentType: 'text/markdown',
				bytes: new Uint8Array(64),
			});
			// A real PNG signature padded out, so the size is the test's to choose
			// while the upload still reads as the image it claims to be.
			const png = new Uint8Array(1024);
			png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
			const shot = await seedAsset(ws, project, { filename: 'shot.png', bytes: png });
			// One asset inside a folder, so the list gets a folder row to lead with.
			await seedAsset(ws, project, { filename: 'buried.png', folder: 'archive' });
			for (const [asset, created] of [
				[rows, '2026-03-01T00:00:00.000Z'],
				[notes, '2026-03-02T00:00:00.000Z'],
				[shot, '2026-03-03T00:00:00.000Z'],
			] as const) {
				await ctx.db.query(`UPDATE assets SET created_at = $1 WHERE id = $2`, [created, asset.id]);
			}
		},
	});
	return { ...helpers, ref };
}

/** The library paths the list is currently showing, in render order. */
function rowOrder(container: HTMLElement): string[] {
	return Array.from(container.querySelectorAll('tbody tr[id^="asset-row-"]')).map((el) =>
		(el.getAttribute('id') ?? '').replace('asset-row-', ''),
	);
}

test('the toggle swaps the grid for the list and carries the choice in the URL', async () => {
	const r = await setup();
	await r.router.navigate({ to: '/projects/$projectId/assets', params: { projectId: r.ref.slug } });
	await r.findByText('shot.png', undefined, { timeout: 15_000 });

	// Grid is the default and writes no param.
	expect(r.container.querySelectorAll('[data-testid="asset-card"]').length).toBeGreaterThan(0);
	expect((r.router.state.location.search as { view?: string }).view).toBeUndefined();

	const toggle = await r.findByTestId('asset-view-toggle');
	const [gridButton, listButton] = Array.from(toggle.querySelectorAll('button'));
	await r.user.click(listButton);

	await waitFor(() => expect(rowOrder(r.container).length).toBe(4));
	expect(r.container.querySelectorAll('[data-testid="asset-card"]').length).toBe(0);
	expect((r.router.state.location.search as { view?: string }).view).toBe('list');

	// Back to the grid drops the param rather than writing the default.
	await r.user.click(gridButton);
	await waitFor(() =>
		expect(r.container.querySelectorAll('[data-testid="asset-card"]').length).toBeGreaterThan(0),
	);
	expect((r.router.state.location.search as { view?: string }).view).toBeUndefined();
});

test('the list leads with folders and shows the columns the grid cannot', async () => {
	const r = await setup();
	await r.router.navigate({
		to: '/projects/$projectId/assets',
		params: { projectId: r.ref.slug },
		search: { view: 'list' },
	});
	await r.findByText('shot.png', undefined, { timeout: 15_000 });

	// Folders first, then the files newest-first (the default order).
	await waitFor(() =>
		expect(rowOrder(r.container)).toEqual(['archive', 'shot.png', 'notes.md', 'rows.csv']),
	);

	// The type token comes off the extension, not the stored content type -
	// a CSV asset stores as text/plain, which would read as "TXT" for the lot.
	const csvRow = r.container.querySelector('#asset-row-rows\\.csv') as HTMLElement;
	expect(csvRow.textContent).toContain('CSV');
	expect(csvRow.textContent).toContain('4.0 KB');
	expect((r.container.querySelector('#asset-row-notes\\.md') as HTMLElement).textContent).toContain(
		'MD',
	);
	// The folder row names itself as one and carries its recursive file count.
	const folderRow = r.container.querySelector('#asset-row-archive') as HTMLElement;
	expect(folderRow.textContent).toContain('Folder');
	expect(folderRow.textContent).toContain('1 file');
});

test('a column header sorts the list and the toolbar control follows it', async () => {
	const r = await setup();
	await r.router.navigate({
		to: '/projects/$projectId/assets',
		params: { projectId: r.ref.slug },
		search: { view: 'list' },
	});
	await r.findByText('shot.png', undefined, { timeout: 15_000 });
	expect((await r.findByTestId('asset-sort-text')).textContent).toBe('Newest first');

	// Size opens largest-first, and the caption beside the toolbar button says so
	// — one piece of state, reached two ways.
	await r.user.click(await r.findByTestId('data-table-sort-size'));
	await waitFor(() =>
		expect(rowOrder(r.container)).toEqual(['archive', 'rows.csv', 'shot.png', 'notes.md']),
	);
	expect((await r.findByTestId('asset-sort-text')).textContent).toBe('Largest first');
	expect((r.router.state.location.search as { sort?: string }).sort).toBe('size_desc');

	// Clicking the sorted column again reverses it, header state included.
	await r.user.click(await r.findByTestId('data-table-sort-size'));
	await waitFor(() =>
		expect(rowOrder(r.container)).toEqual(['archive', 'notes.md', 'shot.png', 'rows.csv']),
	);
	expect((await r.findByTestId('asset-sort-text')).textContent).toBe('Smallest first');
	const sizeHeader = (await r.findByTestId('data-table-sort-size')).closest('th') as HTMLElement;
	expect(sizeHeader.getAttribute('aria-sort')).toBe('ascending');

	// And the toolbar popover is already on the column the header set.
	await r.user.click(await r.findByTestId('asset-sort-button'));
	expect((await r.findByTestId('asset-sort-option-size')).getAttribute('aria-checked')).toBe(
		'true',
	);
	expect((await r.findByTestId('asset-sort-option-name')).getAttribute('aria-checked')).toBe(
		'false',
	);
});

test('the type header groups the list by file extension', async () => {
	const r = await setup();
	await r.router.navigate({
		to: '/projects/$projectId/assets',
		params: { projectId: r.ref.slug },
		search: { view: 'list' },
	});
	await r.findByText('shot.png', undefined, { timeout: 15_000 });

	await r.user.click(await r.findByTestId('data-table-sort-type'));
	// CSV, MD, PNG - ordered by the token the Type column actually shows.
	await waitFor(() =>
		expect(rowOrder(r.container)).toEqual(['archive', 'rows.csv', 'notes.md', 'shot.png']),
	);
	expect((r.router.state.location.search as { sort?: string }).sort).toBe('type_asc');
});

test('an archived row swaps its actions for Restore and Delete', async () => {
	let ws!: SeededWorkspace;
	const ref = { slug: '' };
	const r = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Archived List' });
			ref.slug = project.slug;
			await seedAsset(ws, project, { filename: 'keep-me.png' });
			const old = await seedAsset(ws, project, { filename: 'old-social.png' });
			await archiveSeededAsset(ws, project, old.id);
		},
	});
	await r.router.navigate({
		to: '/projects/$projectId/assets',
		params: { projectId: ref.slug },
		search: { view: 'list', filter: 'all' },
	});
	await r.findByText('old-social.png', undefined, { timeout: 15_000 });

	const archivedRow = r.container.querySelector('#asset-row-old-social\\.png') as HTMLElement;
	expect(archivedRow.querySelector('[data-testid="archived-badge"]')).not.toBeNull();
	expect(archivedRow.querySelector('[data-testid="asset-restore"]')).not.toBeNull();
	expect(archivedRow.querySelector('[data-testid="asset-delete"]')).not.toBeNull();
	expect(archivedRow.querySelector('[data-testid="asset-archive"]')).toBeNull();
	expect(archivedRow.querySelector('[data-testid="asset-move"]')).toBeNull();

	// An active row keeps the reversible three and offers no hard delete.
	const activeRow = r.container.querySelector('#asset-row-keep-me\\.png') as HTMLElement;
	expect(activeRow.querySelector('[data-testid="asset-archive"]')).not.toBeNull();
	expect(activeRow.querySelector('[data-testid="asset-move"]')).not.toBeNull();
	expect(activeRow.querySelector('[data-testid="asset-copy-link"]')).not.toBeNull();
	expect(activeRow.querySelector('[data-testid="asset-delete"]')).toBeNull();
});

test('clicking a folder row opens it and keeps the list view', async () => {
	const r = await setup();
	await r.router.navigate({
		to: '/projects/$projectId/assets',
		params: { projectId: r.ref.slug },
		search: { view: 'list' },
	});
	await r.findByText('shot.png', undefined, { timeout: 15_000 });

	await r.user.click(r.container.querySelector('#asset-row-archive') as HTMLElement);
	await waitFor(() => expect(rowOrder(r.container)).toEqual(['archive/buried.png']));
	const search = r.router.state.location.search as { folder?: string; view?: string };
	expect(search.folder).toBe('archive');
	expect(search.view).toBe('list');
});
