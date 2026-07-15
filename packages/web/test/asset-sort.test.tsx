// Sort control on the Assets page: the "Newest first" caption + popover
// (Newest / Oldest / Alphabetical), the grid re-ordering client-side, and the
// `sort` URL search param tracking the selection (absent for the default).
// Component tier — no layout/scroll/viewport dependency.

import type { AssetSortOrder } from '@hezo/shared';
import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { type SeededWorkspace, seedAsset, seedProject, seedWorkspace } from './helpers/seed';

async function setup() {
	let ws!: SeededWorkspace;
	const ref = { slug: '' };
	const helpers = await renderApp({
		initialPath: '/',
		seed: async (ctx) => {
			ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Sortable Assets' });
			ref.slug = project.slug;
			// Names deliberately differ from creation order so all three sorts
			// produce distinct sequences.
			const banana = await seedAsset(ws, project, { filename: 'banana.png' });
			const apple = await seedAsset(ws, project, { filename: 'apple.png' });
			const cherry = await seedAsset(ws, project, { filename: 'cherry.png' });
			// Pin created_at so date ordering is deterministic (uploads share now()).
			await ctx.db.query(`UPDATE assets SET created_at = $1 WHERE id = $2`, [
				'2026-01-03T00:00:00.000Z',
				banana.id,
			]);
			await ctx.db.query(`UPDATE assets SET created_at = $1 WHERE id = $2`, [
				'2026-01-02T00:00:00.000Z',
				apple.id,
			]);
			await ctx.db.query(`UPDATE assets SET created_at = $1 WHERE id = $2`, [
				'2026-01-01T00:00:00.000Z',
				cherry.id,
			]);
		},
	});
	return { ...helpers, ref };
}

function cardOrder(container: HTMLElement): string[] {
	return Array.from(container.querySelectorAll('[data-testid="asset-card"]')).map(
		(el) => el.getAttribute('data-filename') ?? '',
	);
}

test('the sort control reorders the grid and its caption tracks the selection', async () => {
	const r = await setup();
	await r.router.navigate({ to: '/projects/$projectId/assets', params: { projectId: r.ref.slug } });

	// Default is Newest first: caption says so and the newest asset leads.
	await r.findByText('banana.png', undefined, { timeout: 15_000 });
	expect((await r.findByTestId('asset-sort-text')).textContent).toBe('Newest first');
	await waitFor(() =>
		expect(cardOrder(r.container)).toEqual(['banana.png', 'apple.png', 'cherry.png']),
	);

	// Switch to Oldest first via the popover.
	await r.user.click(await r.findByTestId('asset-sort-button'));
	await r.user.click(await r.findByTestId('asset-sort-option-oldest'));
	expect((await r.findByTestId('asset-sort-text')).textContent).toBe('Oldest first');
	await waitFor(() =>
		expect(cardOrder(r.container)).toEqual(['cherry.png', 'apple.png', 'banana.png']),
	);
	// The non-default sort is reflected in the URL.
	expect((r.router.state.location.search as { sort?: string }).sort).toBe('oldest');

	// Alphabetical orders by filename.
	await r.user.click(await r.findByTestId('asset-sort-button'));
	await r.user.click(await r.findByTestId('asset-sort-option-alphabetical'));
	expect((await r.findByTestId('asset-sort-text')).textContent).toBe('Alphabetical');
	await waitFor(() =>
		expect(cardOrder(r.container)).toEqual(['apple.png', 'banana.png', 'cherry.png']),
	);
	expect((r.router.state.location.search as { sort?: string }).sort).toBe('alphabetical');

	// Back to Newest drops the param entirely (default carries no URL noise).
	await r.user.click(await r.findByTestId('asset-sort-button'));
	await r.user.click(await r.findByTestId('asset-sort-option-newest'));
	await waitFor(() =>
		expect(cardOrder(r.container)).toEqual(['banana.png', 'apple.png', 'cherry.png']),
	);
	expect((r.router.state.location.search as { sort?: string }).sort).toBeUndefined();
});

test('an invalid sort search param falls back to Newest first', async () => {
	const r = await setup();
	await r.router.navigate({
		to: '/projects/$projectId/assets',
		params: { projectId: r.ref.slug },
		// Cast simulates a hand-typed URL carrying an invalid ?sort= value, which
		// validateSearch must drop back to the default.
		search: { sort: 'bogus' as AssetSortOrder },
	});

	await r.findByText('banana.png', undefined, { timeout: 15_000 });
	expect((await r.findByTestId('asset-sort-text')).textContent).toBe('Newest first');
	await waitFor(() =>
		expect(cardOrder(r.container)).toEqual(['banana.png', 'apple.png', 'cherry.png']),
	);
});
