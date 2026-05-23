import { DEFAULT_TEAM_SLUG } from '@hezo/shared';
import { expect, test } from './fixtures';
import { authenticate, waitForPageLoad } from './helpers';

type Page = import('@playwright/test').Page;

async function suppressAiModal(page: Page) {
	await page.route('**/ai-providers/status', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ data: { configured: true } }),
		}),
	);
}

test.describe('Sidebar — visible on global routes (no :teamId in URL)', () => {
	test('renders on /home with links pointing at the default team', async ({ page }) => {
		await authenticate(page);
		await suppressAiModal(page);
		await page.goto('/home');
		await waitForPageLoad(page);

		const nav = page.locator('nav');
		await expect(nav.getByText('Inbox', { exact: true })).toBeVisible();
		await expect(nav.getByText('Work', { exact: true })).toBeVisible();
		await expect(nav.getByText('Projects', { exact: true })).toBeVisible();
		await expect(nav.getByText('Team', { exact: true })).toBeVisible();
		await expect(nav.getByText('Resources', { exact: true })).toBeVisible();

		await nav.getByText('Inbox', { exact: true }).click();
		await expect(page).toHaveURL(new RegExp(`/teams/${DEFAULT_TEAM_SLUG}/inbox/?$`), {
			timeout: 15000,
		});
	});

	test('renders on /settings and on /settings/ai-providers', async ({ page }) => {
		await authenticate(page);
		await suppressAiModal(page);

		await page.goto('/settings');
		await waitForPageLoad(page);
		await expect(page.locator('nav').getByText('Inbox', { exact: true })).toBeVisible();

		await page.goto('/settings/ai-providers');
		await waitForPageLoad(page);
		await expect(page.locator('nav').getByText('Inbox', { exact: true })).toBeVisible();
	});

	test('mobile drawer opens with sidebar on /home', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await authenticate(page);
		await suppressAiModal(page);

		await page.goto('/home');
		await waitForPageLoad(page);

		await expect(page.getByTestId('sidebar-link-tasks')).toBeHidden();

		const toggle = page.getByTestId('mobile-nav-toggle');
		await expect(toggle).toBeVisible();
		await toggle.click();

		const drawer = page.getByTestId('mobile-nav-drawer');
		await expect(drawer).toBeVisible();
		await expect(drawer.getByText('Inbox', { exact: true })).toBeVisible();
		await expect(drawer.getByTestId('sidebar-link-tasks')).toBeVisible();

		await page.getByTestId('mobile-nav-close').click();
		await expect(drawer).toBeHidden();
	});
});
