import { expect, test } from './fixtures';

const DEFAULT_TEAM_SLUG = 'default';

test('invalid team slug redirects to default team', async ({ authedPage }) => {
	await authedPage.goto('/teams/does-not-exist-abc123/issues');
	await authedPage.waitForURL(`**/teams/${DEFAULT_TEAM_SLUG}/**`, { timeout: 20000 });
	expect(new URL(authedPage.url()).pathname.startsWith(`/teams/${DEFAULT_TEAM_SLUG}`)).toBe(true);
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
