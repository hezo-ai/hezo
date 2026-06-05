// Decision-tree items 1–2: rail responsiveness is real-CSS-layout +
// viewport-conditional. The rail wrapper is `hidden md:block` and only surfaces
// on mobile via the hamburger drawer (`lg:hidden`) — happy-dom can't run the
// media queries, so this needs real Chromium + setViewportSize.
import { expect, test } from './fixtures';

test.describe('team rail responsiveness + instance shortcuts', () => {
	test('desktop (1024+) shows the rail with instance shortcuts; hamburger hidden', async ({
		authedPage: page,
	}) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.goto('/home');

		await expect(page.getByTestId('team-rail')).toBeVisible({ timeout: 15000 });
		// Admin (superuser) instance shortcuts are pinned at the bottom of the rail.
		await expect(page.getByTestId('team-rail-skills')).toBeVisible();
		await expect(page.getByTestId('team-rail-connectors')).toBeVisible();
		await expect(page.getByTestId('team-rail-credentials')).toBeVisible();
		await expect(page.getByTestId('team-rail-settings')).toBeVisible();
		// At ≥1024 the hamburger is hidden (the rail/sidebar are inline).
		await expect(page.getByTestId('mobile-nav-toggle')).toBeHidden();
	});

	test('tablet (768–1023) keeps the rail visible', async ({ authedPage: page }) => {
		await page.setViewportSize({ width: 800, height: 900 });
		await page.goto('/home');

		await expect(page.getByTestId('team-rail')).toBeVisible({ timeout: 15000 });
		await expect(page.getByTestId('team-rail-skills')).toBeVisible();
	});

	test('mobile (<768) hides the rail and exposes it (with shortcuts) via the drawer', async ({
		authedPage: page,
	}) => {
		await page.setViewportSize({ width: 375, height: 800 });
		await page.goto('/home');

		// The rail wrapper is `hidden md:block` — not visible at 375px.
		await expect(page.getByTestId('team-rail')).toBeHidden({ timeout: 15000 });

		// The hamburger opens the drawer, which renders the same rail + shortcuts.
		await page.getByTestId('mobile-nav-toggle').click();
		const drawer = page.getByTestId('mobile-nav-drawer');
		await expect(drawer).toBeVisible();
		await expect(drawer.getByTestId('team-rail-skills')).toBeVisible();
		await expect(drawer.getByTestId('team-rail-credentials')).toBeVisible();
	});
});
