import { expect, test } from './fixtures';

test('invalid team slug redirects to /home', async ({ authedPage }) => {
	await authedPage.goto('/teams/does-not-exist-abc123/tasks');
	await authedPage.waitForURL('**/home', { timeout: 20000 });
	expect(new URL(authedPage.url()).pathname).toBe('/home');
});

test('fresh instance (unset master key) redirects deep URL to /', async ({ page }) => {
	await page.route('**/api/status', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ masterKeyState: 'unset', version: 'test' }),
		});
	});

	await page.goto('/teams/foo/projects/bar');
	await page.waitForURL((url) => url.pathname === '/', { timeout: 20000 });
	expect(new URL(page.url()).pathname).toBe('/');
	await expect(page.getByText('Set Master Key')).toBeVisible();
});
