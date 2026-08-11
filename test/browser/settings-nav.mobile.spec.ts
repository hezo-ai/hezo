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
		await page.setViewportSize({ width: 375, height: 700 });
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
		// spec never stated and that has been false twice, most recently when the
		// update banner rendered between the header and the scroller on CI (see
		// HEZO_SKIP_UPDATE_CHECK in playwright.config.ts). Measuring the offset
		// removes the assumption rather than widening the bound.
		const offset = async () => {
			const box = await waitForStableBox(toggle);
			const main = await scroller.boundingBox();
			expect(main).not.toBeNull();
			return box.y - main!.y;
		};

		// Short viewport, so the settings chrome alone overflows <main>. It has to be
		// this short: a fresh instance has no credentials, so the page is a heading
		// and an empty state, and the toggle's own offset (~69px) is a large share of
		// what little content there is.
		//
		// That offset is the bar the scroll range must clear. Below it the toggle
		// never reaches the top, so "it moved less than the scroll did" is equally
		// true of an ordinary element and the test demonstrates nothing - which is
		// what a 360px viewport bought on CI, where the range came to 55px. The
		// precondition is asserted rather than assumed because the page's height is
		// not a constant: it moves with the font that actually loaded, and CI reaches
		// Google Fonts where a sandbox generally cannot.
		await page.setViewportSize({ width: 375, height: 260 });

		const before = await offset();
		const overflow = await scroller.evaluate((el) => el.scrollHeight - el.clientHeight);
		expect(overflow).toBeGreaterThan(before + 30);

		// Scroll the main panel (the only scroller) to the bottom.
		await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
		await page.waitForTimeout(150);
		expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(before);

		const after = await offset();

		// Pinned, and pinned *exactly*: `top-0` on the wrapper puts the toggle flush
		// with the scroller's top edge once the content has scrolled past it. The
		// upper bound catches an element that never pinned; the lower bound catches
		// one that scrolled straight off the top, which the previous "< 40" assertion
		// would have called a pass.
		expect(after).toBeGreaterThanOrEqual(-1);
		expect(after).toBeLessThanOrEqual(1);
	});
});
