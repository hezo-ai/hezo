// Real-CSS-layout assertions (testing decision tree, point 1): the claim is that
// the ⓘ's left edge sits a `gap-1` after the project name's right edge, and that a
// long name truncates instead of shoving the ⓘ out of the panel. Both are resolved
// only by a real layout pass — happy-dom returns zeroed geometry for
// getBoundingClientRect/scrollWidth. Point 2 applies as well: the menu panel is
// `hidden lg:block`, so it needs a real desktop width.
//
// A component test here would be false confidence: the DOM order (name Link, then
// the ⓘ button) is identical before and after the fix, so any DOM-order assertion
// passes against the bug. Only the geometry distinguishes them.

import { HQ_PROJECT_SLUG } from '@hezo/shared';
import { expect, test } from './fixtures';
import { waitForPageLoad } from './helpers';

// The ⓘ renders only for an `is_internal` project, i.e. HQ.
const HQ_TASKS = `/projects/${HQ_PROJECT_SLUG}/tasks`;

test('the info tooltip is suffixed to the project name, not pushed to the panel edge', async ({
	authedPage: page,
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(HQ_TASKS);
	await waitForPageLoad(page);

	const name = page.getByTestId('project-sidebar-name');
	const info = page.getByTestId('project-sidebar-info');
	await expect(name).toBeVisible({ timeout: 20000 });
	await expect(info).toBeVisible();

	const nameBox = await name.boundingBox();
	const infoBox = await info.boundingBox();
	const menuBox = await page.getByTestId('project-menu').boundingBox();
	expect(nameBox).not.toBeNull();
	expect(infoBox).not.toBeNull();
	expect(menuBox).not.toBeNull();

	if (nameBox && infoBox && menuBox) {
		// The row's `gap-1` is 4px; allow slack for sub-pixel text metrics. With the
		// name Link still carrying `flex-1` this gap is ~130px, so this genuinely
		// fails on the unfixed layout rather than passing either way.
		const gap = infoBox.x - (nameBox.x + nameBox.width);
		expect(gap).toBeGreaterThanOrEqual(0);
		expect(gap).toBeLessThanOrEqual(8);

		// And it reads as part of the title rather than as a right-hand control:
		// it sits in the panel's left half, nowhere near the collapse button.
		expect(infoBox.x).toBeLessThan(menuBox.x + menuBox.width / 2);
	}
});

test('a long project name truncates and still keeps the info icon beside it', async ({
	authedPage: page,
}) => {
	const LONG_NAME = 'Headquarters Coordination And Operations Programme Office';

	// Rename HQ in flight rather than over the API: HQ is instance-wide state that
	// parallel Playwright workers share, so a real rename would leak across tests.
	// `useProjectMeta` resolves off `useProjectsIndex` -> GET /api/projects, and it
	// matches on slug, so rewriting the name alone drives the sidebar.
	await page.route('**/api/projects', async (route) => {
		if (route.request().method() !== 'GET') return route.fallback();
		const response = await route.fetch();
		const body = (await response.json()) as { data?: Array<Record<string, unknown>> };
		const data = Array.isArray(body.data)
			? body.data.map((p) => (p.is_internal ? { ...p, name: LONG_NAME } : p))
			: body.data;
		await route.fulfill({ response, json: { ...body, data } });
	});

	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(HQ_TASKS);
	await waitForPageLoad(page);

	const name = page.getByTestId('project-sidebar-name');
	const info = page.getByTestId('project-sidebar-info');
	await expect(name).toHaveText(LONG_NAME, { timeout: 20000 });

	// Visually clipped, but the full text stays in the DOM.
	expect(await name.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);

	const nameBox = await name.boundingBox();
	const infoBox = await info.boundingBox();
	const menuBox = await page.getByTestId('project-menu').boundingBox();
	const collapseBox = await page.getByTestId('project-sidebar-collapse').boundingBox();
	expect(nameBox).not.toBeNull();
	expect(infoBox).not.toBeNull();
	expect(menuBox).not.toBeNull();
	expect(collapseBox).not.toBeNull();

	if (nameBox && infoBox && menuBox && collapseBox) {
		// Still adjacent: the name shrank rather than displacing the icon.
		const gap = infoBox.x - (nameBox.x + nameBox.width);
		expect(gap).toBeGreaterThanOrEqual(0);
		expect(gap).toBeLessThanOrEqual(8);

		// The icon stayed inside the panel and clear of the collapse button's gutter.
		expect(infoBox.x + infoBox.width).toBeLessThanOrEqual(menuBox.x + menuBox.width);
		expect(infoBox.x + infoBox.width).toBeLessThanOrEqual(collapseBox.x + 1);
	}
});
