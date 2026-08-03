// Real-CSS-layout + viewport-conditional assertions (testing decision tree,
// points 1 and 2): the expand tab's docked position (flush under the app header,
// against the project rail's right edge) is measured with boundingBox from the
// real flex/absolute layout, and the whole affordance is gated `lg:` so it must
// be exercised at a real desktop width — neither is computable in happy-dom.
// The sticky-banner test is point 1 too: occlusion is only observable from a real
// layout pass plus a hit-test, and happy-dom has no notion of one element
// covering another.

import { expect, test } from './fixtures';
import { waitForPageLoad } from './helpers';

test('the project menu collapses to a rail-docked expand tab and restores', async ({
	page,
	freshWorkspace,
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`/projects/${freshWorkspace.projectSlug}/tasks`);
	await waitForPageLoad(page);

	// Expanded by default: the menu shows, no expand tab yet.
	await expect(page.getByTestId('project-sidebar-name')).toBeVisible({ timeout: 20000 });
	await expect(page.getByTestId('project-sidebar-expand')).toHaveCount(0);

	// The collapse button hugs the menu panel's top-right corner (absolute
	// positioning, so only measurable from a real layout pass).
	const menu = await page.getByTestId('project-menu').boundingBox();
	const collapseBox = await page.getByTestId('project-sidebar-collapse').boundingBox();
	expect(menu).not.toBeNull();
	expect(collapseBox).not.toBeNull();
	if (menu && collapseBox) {
		const rightGap = menu.x + menu.width - (collapseBox.x + collapseBox.width);
		const topGap = collapseBox.y - menu.y;
		expect(rightGap).toBeGreaterThanOrEqual(0);
		expect(rightGap).toBeLessThanOrEqual(5);
		expect(topGap).toBeGreaterThanOrEqual(0);
		expect(topGap).toBeLessThanOrEqual(5);
	}

	// Collapse from the menu header.
	await page.getByTestId('project-sidebar-collapse').click();

	// The menu is gone and the slim expand tab appears.
	await expect(page.getByTestId('project-sidebar-name')).toHaveCount(0);
	const tab = page.getByTestId('project-sidebar-expand');
	await expect(tab).toBeVisible();

	// It's docked flush under the app header, against the project rail's right edge.
	const header = await page.locator('header').first().boundingBox();
	const rail = await page.getByTestId('project-rail').boundingBox();
	const tabBox = await tab.boundingBox();
	expect(header).not.toBeNull();
	expect(rail).not.toBeNull();
	expect(tabBox).not.toBeNull();
	if (header && rail && tabBox) {
		// Left edge sits at the rail's right edge (±1px sub-pixel rounding).
		expect(Math.abs(tabBox.x - (rail.x + rail.width))).toBeLessThanOrEqual(1);
		// Top edge sits flush under the header (±1px).
		expect(Math.abs(tabBox.y - (header.y + header.height))).toBeLessThanOrEqual(1);
		// It's the intended slim tab, not a tall button.
		expect(tabBox.height).toBeLessThanOrEqual(24);
	}

	// Expand restores the menu and removes the tab.
	await tab.click();
	await expect(page.getByTestId('project-sidebar-name')).toBeVisible();
	await expect(page.getByTestId('project-sidebar-expand')).toHaveCount(0);
});

test('the expand tab stays clickable when a sticky banner tops the page', async ({
	page,
	lightWorkspace,
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });

	// Force the project's container to `error` so ContainerStatusBanner renders.
	// No REST route sets that status - the e2e server runs the in-process fake
	// Docker client, where provisioning succeeds - so drive it from the projects
	// index the banner reads (`useProjectMeta` -> `useProjectsIndex`), the same
	// interception chat.spec.ts uses to pin a container state.
	await page.route('**/api/projects', async (route) => {
		if (route.request().method() !== 'GET') return route.fallback();
		const response = await route.fetch();
		const body = (await response.json()) as { data?: Array<Record<string, unknown>> };
		const data = Array.isArray(body.data)
			? body.data.map((p) =>
					p.slug === lightWorkspace.projectSlug ? { ...p, container_status: 'error' } : p,
				)
			: body.data;
		await route.fulfill({ response, json: { ...body, data } });
	});

	await page.goto(`/projects/${lightWorkspace.projectSlug}/tasks`);
	await waitForPageLoad(page);

	// The banner is `sticky top-0 z-40` at the very top of <main>; collapsed, <main>
	// starts at the rail's right edge, so it lands on the expand tab's corner.
	const banner = page.getByTestId('container-status-banner');
	await expect(banner).toBeVisible({ timeout: 20000 });

	await page.getByTestId('project-sidebar-collapse').click();
	const tab = page.getByTestId('project-sidebar-expand');
	await expect(tab).toBeVisible();

	// The tab is drawn above the banner, so the banner insets its content past it
	// rather than letting the tab bury the warning icon.
	const tabBox = await tab.boundingBox();
	const iconBox = await banner.locator('svg').first().boundingBox();
	expect(tabBox).not.toBeNull();
	expect(iconBox).not.toBeNull();
	if (tabBox && iconBox) {
		expect(iconBox.x).toBeGreaterThanOrEqual(tabBox.x + tabBox.width);
	}

	// Clicking is the assertion that actually catches the bug: toBeVisible() is
	// satisfied by a fully covered element, but Playwright's actionability check
	// hit-tests the click point and fails when another element intercepts it.
	await tab.click();
	await expect(page.getByTestId('project-sidebar-name')).toBeVisible();
});

test('the mobile drawer is unaffected — no collapse affordance there', async ({
	page,
	freshWorkspace,
}) => {
	await page.setViewportSize({ width: 375, height: 800 });
	await page.goto(`/projects/${freshWorkspace.projectSlug}/tasks`);
	await waitForPageLoad(page);

	// The desktop collapse/expand controls never show on mobile.
	await expect(page.getByTestId('project-sidebar-collapse')).toBeHidden();
	await expect(page.getByTestId('project-sidebar-expand')).toHaveCount(0);

	// Opening the drawer surfaces the project menu with no collapse button.
	await page.getByTestId('mobile-nav-toggle').click();
	const drawer = page.getByTestId('mobile-nav-drawer');
	await expect(drawer).toBeVisible();
	await expect(drawer.getByTestId('project-sidebar-name')).toBeVisible({ timeout: 20000 });
	await expect(drawer.getByTestId('project-sidebar-collapse')).toHaveCount(0);
});
