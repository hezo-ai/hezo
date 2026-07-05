// Decision-tree point 1: the create button's placement is real CSS layout —
// `position: sticky` inside the rail's overflow-y scroll container — and the
// assertions compare boundingBox positions and computed box-shadow before and
// after scrolling. happy-dom has no layout engine (scrollHeight/clientHeight
// are 0 and sticky never engages), so this cannot be a component test.

import { expect, test } from './fixtures';
import { mockRailProjects, waitForPageLoad } from './helpers';

test('the create button flows right after the avatar list while it fits the rail', async ({
	sharedPage: page,
	sharedWorkspace,
}) => {
	await mockRailProjects(page, { keepSlug: sharedWorkspace.projectSlug, clones: 0 });
	await page.goto('/home');
	await waitForPageLoad(page);

	const scroller = page.getByTestId('project-rail-scroll');
	const avatar = scroller.locator('[data-testid^="project-rail-avatar-"]').last();
	await expect(avatar).toBeVisible({ timeout: 15_000 });
	const button = page.getByTestId('project-rail-new');
	await expect(button).toBeVisible();

	const avatarBox = await avatar.boundingBox();
	const buttonBox = await button.boundingBox();
	const scrollerBox = await scroller.boundingBox();
	if (!avatarBox || !buttonBox || !scrollerBox) throw new Error('missing layout boxes');

	// Directly below the last avatar (the list gap plus the wrapper padding)…
	expect(buttonBox.y - (avatarBox.y + avatarBox.height)).toBeGreaterThan(0);
	expect(buttonBox.y - (avatarBox.y + avatarBox.height)).toBeLessThan(24);
	// …and far above the bottom of the mostly-empty scroll area, i.e. not pinned.
	expect(scrollerBox.y + scrollerBox.height - (buttonBox.y + buttonBox.height)).toBeGreaterThan(
		100,
	);
	// Inline state: no elevation shadow, and no separator border above it.
	expect(await button.evaluate((el) => getComputedStyle(el).boxShadow)).toBe('none');
	expect(
		await button.evaluate((el) => getComputedStyle(el.parentElement as Element).borderTopWidth),
	).toBe('0px');
});

test('the create button pins to the bottom with a shadow once the avatar list overflows', async ({
	sharedPage: page,
	sharedWorkspace,
}) => {
	await mockRailProjects(page, { keepSlug: sharedWorkspace.projectSlug, clones: 40 });
	await page.goto('/home');
	await waitForPageLoad(page);

	const scroller = page.getByTestId('project-rail-scroll');
	await expect(scroller.locator('[data-testid^="project-rail-avatar-"]').first()).toBeVisible({
		timeout: 15_000,
	});
	// The mocked index must actually overflow the rail for this test to mean anything.
	expect(await scroller.evaluate((el) => el.scrollHeight > el.clientHeight + 1)).toBe(true);

	const button = page.getByTestId('project-rail-new');
	await expect(button).toBeVisible();

	// The overflow measurement lands a paint after the avatars mount — poll for
	// the shadow rather than asserting the very first frame.
	await expect
		.poll(async () => button.evaluate((el) => getComputedStyle(el).boxShadow))
		.not.toBe('none');

	const scrollerBox = await scroller.boundingBox();
	const buttonBox = await button.boundingBox();
	if (!scrollerBox || !buttonBox) throw new Error('missing layout boxes');
	// Pinned at the visible bottom edge of the scroll area (± the wrapper padding).
	expect(
		Math.abs(scrollerBox.y + scrollerBox.height - (buttonBox.y + buttonBox.height)),
	).toBeLessThan(10);
	// The old border-t separator is gone — the shadow is the only elevation cue.
	expect(
		await button.evaluate((el) => getComputedStyle(el.parentElement as Element).borderTopWidth),
	).toBe('0px');

	// It stays put while the avatars scroll beneath it.
	const firstAvatar = scroller.locator('[data-testid^="project-rail-avatar-"]').first();
	const avatarBefore = await firstAvatar.boundingBox();
	if (!avatarBefore) throw new Error('missing avatar box');
	await scroller.evaluate((el) => {
		el.scrollTop = 300;
	});
	await expect.poll(async () => (await firstAvatar.boundingBox())?.y).not.toBe(avatarBefore.y);
	const buttonAfter = await button.boundingBox();
	if (!buttonAfter) throw new Error('missing layout boxes');
	expect(Math.abs(buttonAfter.y - buttonBox.y)).toBeLessThan(2);
});
