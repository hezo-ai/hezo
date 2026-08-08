// Archive filter + archived-card treatment on the Assets page: the funnel
// filter control ("Showing … items" + popover with counts), archived cards'
// badge and swapped action row (Restore + Delete instead of Copy/Move/Archive),
// restore round-trip, and folder counts following the filter. Component tier.

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

async function setupAssetsPage() {
	let ws!: SeededWorkspace;
	const ref = { slug: '' };
	const helpers = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Archive Assets Project' });
			ref.slug = project.slug;
			await seedAsset(ws, project, { filename: 'keep-me.png' });
			const old = await seedAsset(ws, project, { filename: 'old-social.png' });
			await archiveSeededAsset(ws, project, old.id);
		},
	});
	return { ...helpers, ref };
}

test('the funnel filter switches views and its caption tracks the selection', async () => {
	const r = await setupAssetsPage();
	await r.router.navigate({
		to: '/projects/$projectId/assets',
		params: { projectId: r.ref.slug },
	});

	// Default is Active: caption says so and the archived asset is hidden.
	await r.findByText('keep-me.png', undefined, { timeout: 15_000 });
	expect((await r.findByTestId('asset-filter-text')).textContent).toBe('Showing active items');
	expect(r.queryByText('old-social.png')).toBeNull();

	// The popover lists the three views with live counts.
	await r.user.click(await r.findByTestId('asset-filter-button'));
	const allOption = await r.findByTestId('asset-filter-option-all');
	expect(allOption.textContent).toContain('All');
	expect(allOption.textContent).toContain('2');
	expect((await r.findByTestId('asset-filter-option-archived')).textContent).toContain('1');
	expect((await r.findByTestId('asset-filter-option-active')).textContent).toContain('1');

	// "All" shows both; the archived card is badged and its actions swap to
	// Restore + Delete (Copy/Move/Archive are active-card actions).
	await r.user.click(allOption);
	await r.findByText('old-social.png');
	expect((await r.findByTestId('asset-filter-text')).textContent).toBe('Showing all items');
	await r.findByTestId('archived-badge');
	const archivedCard = (await r.findByText('old-social.png')).closest('li') as HTMLElement;
	expect(archivedCard.getAttribute('data-archived')).toBe('true');
	expect(archivedCard.querySelector('[data-testid="asset-restore"]')).toBeTruthy();
	expect(archivedCard.querySelector('[data-testid="asset-delete"]')).toBeTruthy();
	expect(archivedCard.querySelector('[data-testid="asset-archive"]')).toBeNull();
	expect(archivedCard.querySelector('[data-testid="asset-move"]')).toBeNull();
	const activeCard = (await r.findByText('keep-me.png')).closest('li') as HTMLElement;
	expect(activeCard.querySelector('[data-testid="asset-archive"]')).toBeTruthy();
	expect(activeCard.querySelector('[data-testid="asset-delete"]')).toBeNull();
	// Move is offered only while active — the server refuses a move on an
	// archived asset (409 ASSET_ARCHIVED), so hiding it here matches the rule
	// rather than merely papering over it.
	expect(activeCard.querySelector('[data-testid="asset-move"]')).toBeTruthy();
});

test('restoring an archived asset returns it to the Active view', async () => {
	const r = await setupAssetsPage();
	await r.router.navigate({
		to: '/projects/$projectId/assets',
		params: { projectId: r.ref.slug },
		search: { filter: 'archived' },
	});

	await r.findByText('old-social.png', undefined, { timeout: 15_000 });
	expect((await r.findByTestId('asset-filter-text')).textContent).toBe('Showing archived items');
	await r.user.click(await r.findByTestId('asset-restore'));

	// The Archived view empties into its dedicated empty state…
	await r.findByText('No archived assets', undefined, { timeout: 15_000 });

	// …and the Active view has the asset back.
	await r.user.click(await r.findByTestId('asset-filter-button'));
	await r.user.click(await r.findByTestId('asset-filter-option-active'));
	await r.findByText('old-social.png');
});

test('folder cards and counts follow the filter', async () => {
	let ws!: SeededWorkspace;
	const ref = { slug: '' };
	const r = {
		...(await renderApp({
			initialPath: '/',
			seed: async () => {
				ws = await seedWorkspace();
				const project = await seedProject(ws, { name: 'Folder Filter Project' });
				ref.slug = project.slug;
				const a = await seedAsset(ws, project, {
					filename: 'retired-1.png',
					folder: 'old-campaign',
				});
				const b = await seedAsset(ws, project, {
					filename: 'retired-2.png',
					folder: 'old-campaign',
				});
				await seedAsset(ws, project, { filename: 'hero.png', folder: 'launch' });
				await archiveSeededAsset(ws, project, a.id);
				await archiveSeededAsset(ws, project, b.id);
			},
		})),
		ref,
	};
	await r.router.navigate({
		to: '/projects/$projectId/assets',
		params: { projectId: r.ref.slug },
	});

	// Active view: only the launch folder exists — old-campaign holds nothing
	// visible, so it disappears entirely.
	await r.findByText('launch', undefined, { timeout: 15_000 });
	expect(r.queryByText('old-campaign')).toBeNull();

	// The Archived view flips that around, and the folder count reflects only
	// the archived files inside.
	await r.user.click(await r.findByTestId('asset-filter-button'));
	await r.user.click(await r.findByTestId('asset-filter-option-archived'));
	const folder = await r.findByText('old-campaign');
	const folderCard = folder.closest('button') as HTMLElement;
	expect(folderCard.textContent).toContain('2 files');
	await waitFor(() => expect(r.queryByText('launch')).toBeNull());
});
