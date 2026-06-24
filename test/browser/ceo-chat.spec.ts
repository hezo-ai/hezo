import { expect, test } from './fixtures';
import { waitForPageLoad } from './helpers';

// Kept in Playwright by decision-tree items 1 & 2 (real CSS layout +
// viewport-conditional behavior): the CEO chat panel is a near-full-screen sheet
// on mobile and an anchored ~380px panel from md up. happy-dom doesn't run media
// queries against a real layout pass, so boundingBox must come from Chromium.
test.describe('CEO chat widget — responsive layout', () => {
	test('mobile is a near-full-screen sheet; desktop is an anchored panel', async ({
		sharedPage,
		sharedWorkspace,
	}) => {
		const page = sharedPage;

		await page.setViewportSize({ width: 375, height: 800 });
		await page.goto(`/projects/${sharedWorkspace.projectSlug}/tasks`);
		await waitForPageLoad(page);

		// The launcher mounts with the app shell; allow for cold-start boot latency.
		const launcher = page.getByTestId('ceo-chat-launcher');
		await expect(launcher).toBeVisible({ timeout: 15000 });
		await launcher.click();

		const panel = page.getByTestId('ceo-chat-panel');
		await expect(panel).toBeVisible();

		// Mobile: inset-x-2 (8px each side) on a 375px viewport → ~359px wide.
		const mobileBox = await panel.boundingBox();
		expect(mobileBox).not.toBeNull();
		expect(mobileBox?.width ?? 0).toBeGreaterThan(340);

		// Desktop: the same open panel re-lays out to the anchored ~420px width.
		await page.setViewportSize({ width: 1280, height: 800 });
		await expect(panel).toBeVisible();
		const desktopBox = await panel.boundingBox();
		expect(desktopBox).not.toBeNull();
		expect(desktopBox?.width ?? 0).toBeGreaterThan(340);
		expect(desktopBox?.width ?? 0).toBeLessThan(440);
	});

	test('expanding fills the viewport but never covers the nav bar', async ({
		sharedPage,
		sharedWorkspace,
	}) => {
		const page = sharedPage;

		await page.setViewportSize({ width: 1280, height: 800 });
		await page.goto(`/projects/${sharedWorkspace.projectSlug}/tasks`);
		await waitForPageLoad(page);

		const launcher = page.getByTestId('ceo-chat-launcher');
		await expect(launcher).toBeVisible({ timeout: 15000 });
		await launcher.click();

		const panel = page.getByTestId('ceo-chat-panel');
		await expect(panel).toBeVisible();

		// Anchored by default: a narrow corner panel.
		const anchored = await panel.boundingBox();
		expect(anchored?.width ?? 0).toBeLessThan(440);

		// Expand → fills the viewport width…
		await page.getByTestId('ceo-chat-expand').click();
		await expect(panel).toHaveAttribute('data-expanded', 'true');
		const expandedBox = await panel.boundingBox();
		expect(expandedBox).not.toBeNull();
		expect(expandedBox?.width ?? 0).toBeGreaterThan(1000);

		// …but its top stays at or below the header's bottom — the nav stays visible.
		const header = await page.getByTestId('app-header').boundingBox();
		const headerBottom = (header?.y ?? 0) + (header?.height ?? 0);
		expect(headerBottom).toBeGreaterThan(0);
		expect(expandedBox?.y ?? 0).toBeGreaterThanOrEqual(headerBottom - 1);

		// Collapse restores the anchored corner panel.
		await page.getByTestId('ceo-chat-expand').click();
		await expect(panel).toHaveAttribute('data-expanded', 'false');
		const restored = await panel.boundingBox();
		expect(restored?.width ?? 0).toBeLessThan(440);
	});

	test('the expand toggle is desktop-only — hidden on mobile', async ({
		sharedPage,
		sharedWorkspace,
	}) => {
		const page = sharedPage;

		await page.setViewportSize({ width: 375, height: 800 });
		await page.goto(`/projects/${sharedWorkspace.projectSlug}/tasks`);
		await waitForPageLoad(page);

		const launcher = page.getByTestId('ceo-chat-launcher');
		await expect(launcher).toBeVisible({ timeout: 15000 });
		await launcher.click();
		await expect(page.getByTestId('ceo-chat-panel')).toBeVisible();

		// The mobile panel is already near-full-screen, so the control is hidden.
		await expect(page.getByTestId('ceo-chat-expand')).toBeHidden();
	});
});
