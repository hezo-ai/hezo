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
		// Short enough that the settings chrome alone overflows <main>. The height
		// is load-bearing and the spec now says so: at 480px the credentials page
		// (empty, on a fresh instance) fit *within* the scroller, `scrollTo` was a
		// no-op, and the assertions below compared two identical unscrolled
		// layouts - passing without ever exercising stickiness. The overflow
		// precondition is asserted rather than assumed for the same reason.
		await page.setViewportSize({ width: 375, height: 360 });
		await page.goto('/settings/credentials');

		const toggle = page.getByTestId('settings-nav-toggle');
		await expect(toggle).toBeVisible({ timeout: 15000 });
		const scroller = page.locator('main').first();

		// Measured **relative to the scroll container**, not to the viewport.
		//
		// `sticky top-0` is a promise about the element's position within its
		// scrolling ancestor, so that offset is the property under test. Comparing
		// viewport-absolute `y` values across a scroll tests the same thing only
		// while everything above <main> keeps a constant height - an assumption the
		// spec never stated and that does not hold: on a 2-core CI runner the app
		// header above the scroller settles to a taller layout between the two
		// reads, and the toggle appeared to move *down* the page by ~75px in
		// response to a downward scroll, which stickiness cannot do. Measuring the
		// offset removes the assumption rather than widening the bound.
		const offset = async () => {
			const box = await waitForStableBox(toggle);
			const main = await scroller.boundingBox();
			expect(main).not.toBeNull();
			return box.y - main!.y;
		};

		const before = await offset();

		// The content must genuinely overflow, or "it did not move" proves nothing.
		const overflow = await scroller.evaluate((el) => el.scrollHeight - el.clientHeight);
		expect(overflow).toBeGreaterThan(60);

		// Scroll the main panel (the only scroller) to the bottom.
		await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
		await page.waitForTimeout(150);
		expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(30);

		const after = await offset();

		// Sticky: it holds its place at the top of the scroll area instead of
		// travelling up with the content it is pinned above.
		expect(after).toBeLessThanOrEqual(before + 1);
		expect(after).toBeLessThan(40);
	});
});
