// The project rail's avatar list scrolls (`overflow-y-auto`), and an overflow
// scroll container clips its content to the padding box. The unread-count overlay
// badge sits 6px above each avatar (`-top-1.5`), so without enough top padding the
// badge on the TOPMOST avatar gets clipped — the top of the number is sheared off.
// Asserting "not clipped" means comparing the badge's real layout box against the
// scroll container's top edge, which only a browser engine resolves (decision tree
// point 1: real CSS layout / overflow clipping). happy-dom reports 0 for
// boundingBox, so this cannot be a component test.

import { expect, test } from './fixtures';
import { waitForPageLoad } from './helpers';

test('the topmost rail avatar count badge is not clipped by the scroll container', async ({
	sharedPage: page,
}) => {
	// Force a non-zero unread count for every project so a badge renders on the
	// topmost avatar (the one the scroll container would clip). Page-scoped — the
	// sharedPage fixture unroutes on teardown, so sibling tests are unaffected.
	await page.route('**/api/projects/*/inbox/count', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ data: { unread: 3 } }),
		}),
	);

	await page.goto('/home');
	await waitForPageLoad(page);

	await expect(page.getByTestId('project-rail')).toBeVisible({ timeout: 15_000 });

	const scroller = page.getByTestId('project-rail-scroll');
	// The first badge in DOM order is the topmost avatar's (flex column → DOM
	// order is top-to-bottom), which is the one at risk of top clipping.
	const topBadge = page.locator('[data-testid^="project-rail-inbox-badge-"]').first();
	await expect(topBadge).toBeVisible({ timeout: 15_000 });

	const scrollerBox = await scroller.boundingBox();
	const badgeBox = await topBadge.boundingBox();
	if (!scrollerBox || !badgeBox) {
		throw new Error('rail scroll container or badge has no layout box');
	}

	// The badge's top edge must sit at or below the scroll container's top edge;
	// anything above it is clipped away. The sub-pixel tolerance absorbs rounding —
	// the regression sheared off a full ~2px.
	expect(badgeBox.y).toBeGreaterThanOrEqual(scrollerBox.y - 0.5);
});
