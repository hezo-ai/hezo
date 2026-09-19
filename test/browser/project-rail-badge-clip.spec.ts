// The rail's unread-count badge sits 6px past the top-right corner of the icon it
// marks (`-top-1.5 -right-1.5`), so any clipping box around that icon shears it.
// Two have: the avatar list's `overflow-y-auto`, which cut the top off the badge
// on the TOPMOST avatar, and the pinned HQ entry's own link, which carried the
// `overflow-hidden` that clips a full-bleed project icon to its circle and sheared
// the HQ badge to a wedge in the corner.
//
// Asserting "not clipped" needs a browser (decision tree point 1: real CSS layout
// and overflow clipping). happy-dom reports 0 for boundingBox and does not resolve
// computed `overflow`, so this cannot be a component test. `visibleFraction` walks
// the clipping ancestors and returns the share of the badge that survives them;
// layout boxes alone would not catch the HQ case at all, since `overflow: hidden`
// changes what is painted and not what is laid out.

import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { visibleFraction, waitForPageLoad } from './helpers';

/**
 * Force a non-zero unread count on every project so a badge renders. Page-scoped —
 * the sharedPage fixture unroutes on teardown, so sibling tests are unaffected. The
 * pattern matches HQ's own count too, which is fetched separately from the rail's
 * visible-project map.
 */
async function stubUnreadCounts(page: Page) {
	await page.route('**/api/projects/*/inbox/count', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ data: { unread: 3 } }),
		}),
	);
}

test('no rail count badge is clipped by its icon or by the scroll container', async ({
	sharedPage: page,
}) => {
	await stubUnreadCounts(page);
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto('/home');
	await waitForPageLoad(page);

	await expect(page.getByTestId('project-rail')).toBeVisible({ timeout: 15_000 });

	// The first badge in DOM order is the topmost avatar's (flex column → DOM order
	// is top-to-bottom), which is the one the scroll container would clip.
	const topBadge = page.locator('[data-testid^="project-rail-inbox-badge-"]').first();
	await expect(topBadge).toBeVisible({ timeout: 15_000 });
	expect(await visibleFraction(topBadge)).toBe(1);

	// HQ is pinned below the scroll area and draws its own circle, so it is clipped
	// by its own link rather than by the list. The regression left about a third.
	const hqBadge = page.getByTestId('project-rail-hq-inbox-badge');
	await expect(hqBadge).toBeVisible({ timeout: 15_000 });
	expect(await visibleFraction(hqBadge)).toBe(1);
});

test('the HQ count badge is not clipped in the mobile drawer', async ({ sharedPage: page }) => {
	await stubUnreadCounts(page);
	// Below md the shell's own rail is `hidden md:flex`; the rail the operator sees
	// is the drawer's copy, so it is the one to measure here.
	await page.setViewportSize({ width: 375, height: 700 });
	await page.goto('/home');
	await waitForPageLoad(page);

	await page.getByTestId('mobile-nav-toggle').click();
	const drawer = page.getByTestId('mobile-nav-drawer');
	await expect(drawer).toBeVisible({ timeout: 15_000 });

	const hqBadge = drawer.getByTestId('project-rail-hq-inbox-badge');
	await expect(hqBadge).toBeVisible({ timeout: 15_000 });
	expect(await visibleFraction(hqBadge)).toBe(1);
});
