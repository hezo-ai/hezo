import { expect, test } from './fixtures';
import { waitForPageLoad } from './helpers';

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

test.describe('Sidebar — mobile drawer', () => {
	test('mobile viewport opens navigation via hamburger drawer', async ({
		page,
		freshWorkspace,
	}) => {
		await page.setViewportSize({ width: 375, height: 812 });
		const { team } = freshWorkspace;
		await suppressAiModal(page);

		await page.goto(`/teams/${team.slug}/tasks`);
		await waitForPageLoad(page);

		await expect(page.getByTestId('sidebar-link-tasks')).toBeHidden();

		const toggle = page.getByTestId('mobile-nav-toggle');
		await expect(toggle).toBeVisible();
		await toggle.click();

		const drawer = page.getByTestId('mobile-nav-drawer');
		await expect(drawer).toBeVisible();
		await expect(drawer.getByTestId('sidebar-link-tasks')).toBeVisible();

		await page.getByTestId('mobile-nav-close').click();
		await expect(drawer).toBeHidden();
	});
});
