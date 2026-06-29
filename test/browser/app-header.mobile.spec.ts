// Decision-tree items 1–2: header + project-rail responsiveness is real-CSS
// layout + viewport-conditional. The project-rail wrapper is `hidden md:flex`
// and the header hamburger is `lg:hidden` — happy-dom can't run the media
// queries, so this needs real Chromium + setViewportSize.
import { expect, test } from './fixtures';

test.describe('app header + project rail responsiveness', () => {
	test('desktop (1024+) shows the header shortcuts and the inline project rail; hamburger hidden', async ({
		authedPage: page,
	}) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.goto('/home');

		await expect(page.getByTestId('app-header')).toBeVisible({ timeout: 15000 });
		// The header's top-right group: Inbox + Settings (Skills now lives in the
		// Settings sidebar, and the All Tasks view was removed).
		await expect(page.getByTestId('app-header-settings')).toBeVisible();
		await expect(page.getByTestId('app-header-inbox')).toBeVisible();
		await expect(page.getByTestId('app-header-skills')).toHaveCount(0);
		await expect(page.getByTestId('app-header-all-tasks')).toHaveCount(0);
		// The avatar rail is inline at ≥768; the hamburger is hidden at ≥1024.
		await expect(page.getByTestId('project-rail')).toBeVisible();
		await expect(page.getByTestId('mobile-nav-toggle')).toBeHidden();
	});

	test('tablet (768–1023) keeps the header and the inline project rail', async ({
		authedPage: page,
	}) => {
		await page.setViewportSize({ width: 800, height: 900 });
		await page.goto('/home');

		await expect(page.getByTestId('app-header')).toBeVisible({ timeout: 15000 });
		await expect(page.getByTestId('project-rail')).toBeVisible();
	});

	test('mobile (<768) hides the inline rail and exposes it via the hamburger drawer', async ({
		authedPage: page,
	}) => {
		await page.setViewportSize({ width: 375, height: 800 });
		await page.goto('/home');

		await expect(page.getByTestId('app-header')).toBeVisible({ timeout: 15000 });
		// The project-rail wrapper is `hidden md:flex` — not visible at 375px.
		await expect(page.getByTestId('project-rail')).toBeHidden();

		await page.getByTestId('mobile-nav-toggle').click();
		const drawer = page.getByTestId('mobile-nav-drawer');
		await expect(drawer).toBeVisible();
		await expect(drawer.getByTestId('project-rail')).toBeVisible();

		await page.getByTestId('mobile-nav-close').click();
		await expect(drawer).toBeHidden();
	});
});
