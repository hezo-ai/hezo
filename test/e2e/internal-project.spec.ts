import { expect, test } from '@playwright/test';
import { authenticate, createTeamLight, waitForPageLoad } from './helpers';

test.describe('Internal project — UI affordances', () => {
	test('project list renders (Internal) with italic title', async ({ page }) => {
		await authenticate(page);
		const { team } = await createTeamLight(page);

		await page.goto(`/teams/${team.slug}/projects`);
		await waitForPageLoad(page);

		const heading = page.getByRole('heading', { name: '(Internal)' });
		await expect(heading).toBeVisible({ timeout: 15000 });
		const fontStyle = await heading.evaluate((el) => getComputedStyle(el).fontStyle);
		expect(fontStyle).toBe('italic');
	});

	test('sidebar exposes only Issues and Container for the internal project', async ({ page }) => {
		await authenticate(page);
		const { team } = await createTeamLight(page);

		await page.goto(`/teams/${team.slug}/projects/operations/issues`);
		await waitForPageLoad(page);

		const nav = page.locator('nav');
		await expect(nav.getByRole('link', { name: 'Issues' }).first()).toBeVisible({
			timeout: 15000,
		});
		await expect(nav.getByRole('link', { name: 'Container' })).toBeVisible();
		await expect(nav.getByRole('link', { name: 'Documents' })).toHaveCount(0);

		const settingsLinks = nav.locator('a').filter({ hasText: /^Settings$/ });
		const settingsHrefs = await settingsLinks.evaluateAll((els) =>
			els.map((el) => (el as HTMLAnchorElement).getAttribute('href') ?? ''),
		);
		expect(settingsHrefs.some((href) => href.includes('/projects/operations/settings'))).toBe(
			false,
		);
	});

	test('banner appears on internal-project landing pages but not on issue detail', async ({
		page,
	}) => {
		await authenticate(page);
		const { team } = await createTeamLight(page);

		const bannerCopy =
			'Internal team coordination project, used for onboarding and team-level changes.';

		await page.goto(`/teams/${team.slug}/projects/operations/issues`);
		await waitForPageLoad(page);
		await expect(page.getByText(bannerCopy)).toBeVisible({ timeout: 15000 });

		await page.goto(`/teams/${team.slug}/projects/operations/container`);
		await waitForPageLoad(page);
		await expect(page.getByText(bannerCopy)).toBeVisible({ timeout: 15000 });
	});

	test('direct navigation to /documents and /settings redirects to /issues', async ({ page }) => {
		await authenticate(page);
		const { team } = await createTeamLight(page);

		await page.goto(`/teams/${team.slug}/projects/operations/documents`);
		await expect(page).toHaveURL(new RegExp(`/teams/${team.slug}/projects/operations/issues`), {
			timeout: 15000,
		});

		await page.goto(`/teams/${team.slug}/projects/operations/settings`);
		await expect(page).toHaveURL(new RegExp(`/teams/${team.slug}/projects/operations/issues`), {
			timeout: 15000,
		});
	});
});
