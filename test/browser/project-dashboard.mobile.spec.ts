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

	// Decision-tree point 1: the two dashboard columns are a `lg:` grid and the metric strip
	// reflows across three breakpoints. happy-dom runs no media queries against a layout pass, so
	// only a real browser can say which arrangement a given width actually gets.
	test('the two columns stack on a phone and sit side by side on desktop', async ({
		page,
		freshWorkspace,
	}) => {
		await page.goto(`/projects/${freshWorkspace.projectSlug}/dashboard`);
		await waitForPageLoad(page);

		const work = page.getByTestId('dashboard-in-progress');
		const agents = page.getByTestId('dashboard-active-agents');
		await expect(work).toBeVisible({ timeout: 20_000 });
		await expect(agents).toBeVisible();

		// Phone: one column, so the metric strip is no wider than the viewport and the work
		// column starts at the same left edge as everything above it.
		const metrics = page.getByTestId('dashboard-metrics');
		const metricsBox = (await metrics.boundingBox())!;
		const workBox = (await work.boundingBox())!;
		const agentsBox = (await agents.boundingBox())!;
		expect(metricsBox.width).toBeLessThanOrEqual(390);
		expect(Math.abs(workBox.x - agentsBox.x)).toBeLessThan(2);
		// The page must never scroll sideways at this width.
		const overflow = await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
		);
		expect(overflow).toBeLessThanOrEqual(1);

		// Desktop: the goals card moves beside the work column rather than under it.
		await page.setViewportSize({ width: 1280, height: 900 });
		await waitForPageLoad(page);
		const goals = page.getByTestId('dashboard-goals');
		await expect(goals).toBeVisible({ timeout: 15_000 });
		const wideWork = (await work.boundingBox())!;
		const wideGoals = (await goals.boundingBox())!;
		expect(wideGoals.x).toBeGreaterThan(wideWork.x + wideWork.width - 2);
	});
});
