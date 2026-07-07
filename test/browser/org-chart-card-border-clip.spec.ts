// Playwright (decision tree #1: real CSS layout / overflow clipping). The org
// chart auto-fits by scaling its content and clipping the wrapper to a computed
// height via `overflow-hidden`. If that height doesn't account for the wrapper's
// vertical padding, the padding eats into the border box and the bottom row's
// cards have their 1px bottom border sheared off. Asserting "not clipped" means
// comparing each bottom-row card's real layout box against the clip container's
// bottom edge — only a browser engine resolves this. happy-dom reports 0 for
// boundingBox, so this cannot be a component test.

import { expect, test } from './fixtures';
import { waitForPageLoad } from './helpers';

test('bottom-row agent cards are not clipped by the org-chart viewport', async ({
	sharedPage: page,
	sharedWorkspace,
}) => {
	const { projectSlug } = sharedWorkspace;

	await page.goto(`/projects/${projectSlug}/agents`);
	await waitForPageLoad(page);

	const viewport = page.getByTestId('team-org-chart-viewport');
	await expect(viewport).toBeVisible({ timeout: 15_000 });

	// Every card except the synthetic "You (Admin)" root is a Link (an <a>). The
	// bottom row is whichever cards have the greatest bottom edge.
	const cards = viewport.getByRole('link');
	await expect(cards.first()).toBeVisible({ timeout: 15_000 });

	const viewportBox = await viewport.boundingBox();
	if (!viewportBox) throw new Error('org-chart viewport has no layout box');
	const viewportBottom = viewportBox.y + viewportBox.height;

	const count = await cards.count();
	let lowestCardBottom = Number.NEGATIVE_INFINITY;
	for (let i = 0; i < count; i++) {
		const box = await cards.nth(i).boundingBox();
		if (!box) continue;
		lowestCardBottom = Math.max(lowestCardBottom, box.y + box.height);
	}
	expect(lowestCardBottom).toBeGreaterThan(Number.NEGATIVE_INFINITY);

	// The lowest card's bottom edge (border included) must sit at or above the
	// viewport's clipped bottom edge; anything below is sheared off. The 1px
	// tolerance absorbs sub-pixel rounding — the regression clipped a full ~4px.
	expect(lowestCardBottom).toBeLessThanOrEqual(viewportBottom + 1);
});
