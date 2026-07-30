// Real-CSS-layout + viewport-conditional assertions (testing decision tree,
// points 1 and 2): the expand tab's docked position (flush under the app header,
// against the project rail's right edge) is measured with boundingBox from the
// real flex/absolute layout, and the whole affordance is gated `lg:` so it must
// be exercised at a real desktop width — neither is computable in happy-dom.

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
	await expect(page.getByTestId('project-sidebar-dashboard')).toBeVisible({ timeout: 20000 });
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
	await expect(page.getByTestId('project-sidebar-dashboard')).toHaveCount(0);
	const tab = page.getByTestId('project-sidebar-expand');
	await expect(tab).toBeVisible();

	// It's docked where the menu used to start, against the project rail's right edge.
	const rail = await page.getByTestId('project-rail').boundingBox();
	const tabBox = await tab.boundingBox();
	expect(menu).not.toBeNull();
	expect(rail).not.toBeNull();
	expect(tabBox).not.toBeNull();
	if (menu && rail && tabBox) {
		// Left edge sits at the rail's right edge (±1px sub-pixel rounding).
		expect(Math.abs(tabBox.x - (rail.x + rail.width))).toBeLessThanOrEqual(1);
		// Top edge stays aligned with the menu's former top edge (±1px).
		expect(Math.abs(tabBox.y - menu.y)).toBeLessThanOrEqual(1);
		// It's the intended slim tab, not a tall button.
		expect(tabBox.height).toBeLessThanOrEqual(24);
	}

	// Expand restores the menu and removes the tab.
	await tab.click();
	await expect(page.getByTestId('project-sidebar-dashboard')).toBeVisible();
	await expect(page.getByTestId('project-sidebar-expand')).toHaveCount(0);
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
	await expect(drawer.getByTestId('project-sidebar-dashboard')).toBeVisible({ timeout: 20000 });
	await expect(drawer.getByTestId('project-sidebar-collapse')).toHaveCount(0);
});
