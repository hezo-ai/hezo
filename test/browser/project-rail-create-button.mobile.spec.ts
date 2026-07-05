// Decision-tree points 1–2: on mobile the rail only exists inside the
// hamburger drawer (viewport-conditional), and the create button's placement
// is real sticky/scroll layout. happy-dom runs neither media queries nor
// layout, so this needs Chromium at the mobile viewport.

import { expect, test } from './fixtures';
import { mockRailProjects, waitForPageLoad } from './helpers';

test('mobile drawer: the create button follows the avatar list while it fits', async ({
	sharedPage: page,
	sharedWorkspace,
}) => {
	await mockRailProjects(page, { keepSlug: sharedWorkspace.projectSlug, clones: 0 });
	await page.goto('/home');
	await waitForPageLoad(page);

	await page.getByTestId('mobile-nav-toggle').click();
	// The hidden desktop rail stays in the DOM at mobile widths, so scope every
	// query to the drawer.
	const drawer = page.getByTestId('mobile-nav-drawer');
	await expect(drawer).toBeVisible();

	const scroller = drawer.getByTestId('project-rail-scroll');
	const avatar = scroller.locator('[data-testid^="project-rail-avatar-"]').last();
	await expect(avatar).toBeVisible({ timeout: 15_000 });
	const button = drawer.getByTestId('project-rail-new');
	await expect(button).toBeVisible();

	const avatarBox = await avatar.boundingBox();
	const buttonBox = await button.boundingBox();
	const scrollerBox = await scroller.boundingBox();
	if (!avatarBox || !buttonBox || !scrollerBox) throw new Error('missing layout boxes');

	// Directly below the last avatar, not pinned to the drawer bottom.
	expect(buttonBox.y - (avatarBox.y + avatarBox.height)).toBeLessThan(24);
	expect(scrollerBox.y + scrollerBox.height - (buttonBox.y + buttonBox.height)).toBeGreaterThan(
		100,
	);
	expect(await button.evaluate((el) => getComputedStyle(el).boxShadow)).toBe('none');
});

test('mobile drawer: the create button pins to the bottom with a shadow when the list overflows', async ({
	sharedPage: page,
	sharedWorkspace,
}) => {
	await mockRailProjects(page, { keepSlug: sharedWorkspace.projectSlug, clones: 40 });
	await page.goto('/home');
	await waitForPageLoad(page);

	await page.getByTestId('mobile-nav-toggle').click();
	const drawer = page.getByTestId('mobile-nav-drawer');
	await expect(drawer).toBeVisible();

	const scroller = drawer.getByTestId('project-rail-scroll');
	await expect(scroller.locator('[data-testid^="project-rail-avatar-"]').first()).toBeVisible({
		timeout: 15_000,
	});
	expect(await scroller.evaluate((el) => el.scrollHeight > el.clientHeight + 1)).toBe(true);

	const button = drawer.getByTestId('project-rail-new');
	await expect(button).toBeVisible();
	await expect
		.poll(async () => button.evaluate((el) => getComputedStyle(el).boxShadow))
		.not.toBe('none');

	const scrollerBox = await scroller.boundingBox();
	const buttonBox = await button.boundingBox();
	if (!scrollerBox || !buttonBox) throw new Error('missing layout boxes');
	// Pinned at the visible bottom edge of the drawer's scroll area, no border.
	expect(
		Math.abs(scrollerBox.y + scrollerBox.height - (buttonBox.y + buttonBox.height)),
	).toBeLessThan(10);
	expect(
		await button.evaluate((el) => getComputedStyle(el.parentElement as Element).borderTopWidth),
	).toBe('0px');
});
