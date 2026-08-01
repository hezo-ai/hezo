// Decision-tree items 1–2: the Settings nav is viewport-conditional (desktop
// rail vs. mobile collapsed menu, `hidden md:flex` / `md:hidden`) and the mobile
// menu is `sticky top-0`, which is real-CSS layout. happy-dom can't run the
// media queries or compute sticky offsets, so this needs real Chromium.
import { expect, test } from './fixtures';
import { waitForStableBox } from './helpers';

test.describe('settings navigation responsiveness', () => {
	test('desktop (1024+) shows the persistent sidebar; the mobile toggle is hidden', async ({
		authedPage: page,
	}) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.goto('/settings');

		await expect(page.getByTestId('settings-nav-desktop')).toBeVisible({ timeout: 15000 });
		await expect(page.getByTestId('settings-nav-toggle')).toBeHidden();
	});

	test('mobile (<768) collapses the menu into a top-pinned button that opens a dropdown', async ({
		authedPage: page,
	}) => {
		await page.setViewportSize({ width: 375, height: 700 });
		await page.goto('/settings');

		// The desktop rail is `hidden md:flex` — gone at 375px; the collapsed toggle
		// shows the current subpage (General is the default /settings page).
		await expect(page.getByTestId('settings-nav-desktop')).toBeHidden({ timeout: 15000 });
		const toggle = page.getByTestId('settings-nav-toggle');
		await expect(toggle).toBeVisible();
		await expect(toggle).toContainText('General');

		// Tapping opens the dropdown; choosing a subpage navigates and the toggle
		// label follows the selection.
		await toggle.click();
		await page.getByRole('link', { name: 'Skills' }).click();
		await expect(page).toHaveURL(/\/settings\/skills$/);
		await expect(toggle).toContainText('Skills');
	});

	test('mobile menu stays pinned to the top while the page scrolls', async ({
		authedPage: page,
	}) => {
		// A short viewport guarantees the content overflows so <main> can scroll.
		await page.setViewportSize({ width: 375, height: 480 });
		await page.goto('/settings/credentials');

		const toggle = page.getByTestId('settings-nav-toggle');
		await expect(toggle).toBeVisible({ timeout: 15000 });

		// Settled first: a box read while the page is still arriving is a reading of
		// a different layout than the one after the scroll, which shows up as the
		// element moving *down* - something `position: sticky` cannot do.
		const before = await waitForStableBox(toggle);
		expect(before).not.toBeNull();

		// Scroll the main panel (the only scroller) down.
		await page
			.locator('main')
			.first()
			.evaluate((el) => el.scrollTo({ top: 600 }));
		await page.waitForTimeout(150);

		const after = await toggle.boundingBox();
		expect(after).not.toBeNull();
		// Sticky: the toggle does not scroll up off-screen — it pins at/near the top
		// of the scroll area rather than moving with the content.
		expect(after!.y).toBeLessThanOrEqual(before!.y + 1);
		expect(after!.y).toBeLessThan(120);
	});
});
