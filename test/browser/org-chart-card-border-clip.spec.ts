// Playwright (decision tree #1: real CSS layout / overflow clipping). The org
// chart auto-fits by scaling its content into a sizer box of the scaled size.
// Anything that eats into the height available to that box shears the bottom
// row's cards of their 1px bottom border: originally a forced border-box height
// the wrapper's vertical padding ate into, and now also a horizontal scrollbar
// on a chart too wide to fit. Asserting "not clipped" means
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
	// Measure to the bottom of the *visible* area, not the border box: on a wide
	// roster the viewport scrolls horizontally, and a space-taking scrollbar comes
	// out of the content box. `clientHeight` excludes it, so this catches both the
	// original clip (padding eating into a forced height) and the newer way to
	// shear the same border - a scrollbar laid over the bottom row.
	const clientHeight = await viewport.evaluate((el) => el.clientHeight);
	const viewportBottom = viewportBox.y + clientHeight;

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
