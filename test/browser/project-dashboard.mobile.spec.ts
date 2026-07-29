// Decision-tree points 1–2: on mobile the project rail and sidebar only exist
// inside the hamburger drawer (viewport-conditional). The hidden desktop copies
// stay in the DOM, so every query must be scoped to the drawer.

import { expect, test } from './fixtures';
import { waitForPageLoad } from './helpers';

test.describe('Project dashboard — mobile (390px)', () => {
	test('rail opens project on dashboard by default', async ({ page, freshWorkspace }) => {
		await page.goto('/home');
		await waitForPageLoad(page);

		await page.getByTestId('mobile-nav-toggle').click();
		const drawer = page.getByTestId('mobile-nav-drawer');
		await expect(drawer).toBeVisible();

		await drawer.getByTestId(`project-rail-avatar-${freshWorkspace.projectSlug}`).click();
		await waitForPageLoad(page);

		await expect(page).toHaveURL(new RegExp(`/projects/${freshWorkspace.projectSlug}/dashboard`));
		await expect(page.getByTestId('project-dashboard')).toBeVisible({ timeout: 20_000 });
	});

	test('project title link (dashboard) appears above Inbox in the sidebar', async ({
		page,
		freshWorkspace,
	}) => {
		await page.goto(`/projects/${freshWorkspace.projectSlug}/dashboard`);
		await waitForPageLoad(page);

		await page.getByTestId('mobile-nav-toggle').click();
		const drawer = page.getByTestId('mobile-nav-drawer');
		await expect(drawer).toBeVisible();

		// The project title is now the dashboard link — it lives above the nav list.
		const dashboardLink = drawer.getByTestId('project-sidebar-dashboard');
		await expect(dashboardLink).toBeVisible({ timeout: 15_000 });

		const inboxLink = drawer.getByTestId('sidebar-link-inbox');
		await expect(inboxLink).toBeVisible();

		const dashboardBox = await dashboardLink.boundingBox();
		const inboxBox = await inboxLink.boundingBox();
		expect(dashboardBox).not.toBeNull();
		expect(inboxBox).not.toBeNull();
		expect(dashboardBox!.y).toBeLessThan(inboxBox!.y);
	});
});
