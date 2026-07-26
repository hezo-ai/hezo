// Decision-tree point 1: a drag gesture is only meaningful against real CSS
// layout — the assertions read boundingBox() to find where an avatar sits and to
// aim the pointer at a neighbour's slot, and the hook measures item pitch from
// getBoundingClientRect. happy-dom has no layout engine (every rect is zeros)
// and no pointer capture, so the ordering contract, the keyboard path, the
// superuser gate, and rollback are covered in
// packages/web/test/project-rail-reorder.test.tsx and the pure geometry in
// packages/web/test/list-reorder.test.ts; what needs Chromium lives here.

import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import {
	createProjectAndClearPlanning,
	mockRailProjects,
	scopeRailToProjects,
	uniqueName,
	waitForPageLoad,
} from './helpers';

/** The rail's avatar slugs, top to bottom. */
async function railOrder(page: Page): Promise<string[]> {
	return page
		.getByTestId('project-rail-scroll')
		.locator('[data-testid^="project-rail-avatar-"]')
		.evaluateAll((els) =>
			els.map((el) => el.getAttribute('data-testid')?.replace('project-rail-avatar-', '') ?? ''),
		);
}

/** Press on `from`'s centre and drag to `to`'s centre, crossing the 8px threshold. */
async function dragOnto(page: Page, from: Locator, to: Locator): Promise<void> {
	const a = await from.boundingBox();
	const b = await to.boundingBox();
	if (!a || !b) throw new Error('missing layout boxes');
	await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
	await page.mouse.down();
	// Several steps so the gesture passes the drag threshold before it lands.
	await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
	await page.mouse.up();
}

/** Three real projects, with the rail scoped to exactly them (plus HQ). */
async function seedThreeProjects(page: Page, token: string, label: string) {
	const projects = [];
	for (const suffix of ['A', 'B', 'C']) {
		projects.push(
			await createProjectAndClearPlanning(page, '', token, {
				name: uniqueName(`${label} ${suffix}`),
				description: 'E2E project-rail reordering.',
			}),
		);
	}
	await scopeRailToProjects(
		page,
		projects.map((p) => p.slug),
	);
	// Each project is created on top of the last, so the rail is C, B, A.
	return { projects, initialOrder: [projects[2].slug, projects[1].slug, projects[0].slug] };
}

test('dragging an avatar down the rail reorders it, and the new order survives a reload', async ({
	page,
	sharedWorkspace,
}) => {
	const { projects, initialOrder } = await seedThreeProjects(
		page,
		sharedWorkspace.token,
		'Reorder',
	);

	await page.goto('/home');
	await waitForPageLoad(page);
	const scroller = page.getByTestId('project-rail-scroll');
	await expect(scroller.locator('[data-testid^="project-rail-avatar-"]')).toHaveCount(3, {
		timeout: 15_000,
	});
	expect(await railOrder(page)).toEqual(initialOrder);

	const first = page.getByTestId(`project-rail-avatar-${initialOrder[0]}`);
	const last = page.getByTestId(`project-rail-avatar-${initialOrder[2]}`);

	// Mutation landing is not the same as the rail re-rendering, so wait for the
	// PUT *and* the index refetch it invalidates before asserting on order.
	const savePut = page.waitForResponse(
		(r) =>
			new URL(r.url()).pathname === '/api/project-display-order' && r.request().method() === 'PUT',
	);
	const refetch = page.waitForResponse(
		(r) => new URL(r.url()).pathname === '/api/projects' && r.request().method() === 'GET',
	);
	await dragOnto(page, first, last);
	const [putRes] = await Promise.all([savePut, refetch]);
	expect(putRes.status()).toBe(200);

	const moved = [initialOrder[1], initialOrder[2], initialOrder[0]];
	await expect.poll(() => railOrder(page)).toEqual(moved);

	// It is genuinely persisted, not just optimistic state.
	await page.reload();
	await waitForPageLoad(page);
	await expect(scroller.locator('[data-testid^="project-rail-avatar-"]')).toHaveCount(3, {
		timeout: 15_000,
	});
	expect(await railOrder(page)).toEqual(moved);
	expect(projects).toHaveLength(3);
});

test('dragging an avatar up the rail moves it toward the top', async ({
	page,
	sharedWorkspace,
}) => {
	const { initialOrder } = await seedThreeProjects(page, sharedWorkspace.token, 'Reorder Up');

	await page.goto('/home');
	await waitForPageLoad(page);
	await expect(
		page.getByTestId('project-rail-scroll').locator('[data-testid^="project-rail-avatar-"]'),
	).toHaveCount(3, { timeout: 15_000 });
	expect(await railOrder(page)).toEqual(initialOrder);

	const savePut = page.waitForResponse(
		(r) =>
			new URL(r.url()).pathname === '/api/project-display-order' && r.request().method() === 'PUT',
	);
	await dragOnto(
		page,
		page.getByTestId(`project-rail-avatar-${initialOrder[2]}`),
		page.getByTestId(`project-rail-avatar-${initialOrder[0]}`),
	);
	expect((await savePut).status()).toBe(200);

	await expect
		.poll(() => railOrder(page))
		.toEqual([initialOrder[2], initialOrder[0], initialOrder[1]]);
});

test('a plain click on an avatar still navigates — the drag never swallows a tap', async ({
	page,
	sharedWorkspace,
}) => {
	const { initialOrder } = await seedThreeProjects(page, sharedWorkspace.token, 'Reorder Click');

	await page.goto('/home');
	await waitForPageLoad(page);
	const avatar = page.getByTestId(`project-rail-avatar-${initialOrder[0]}`);
	await expect(avatar).toBeVisible({ timeout: 15_000 });

	await avatar.click();
	await expect(page).toHaveURL(new RegExp(`/projects/${initialOrder[0]}(/|$)`));
	// A click is not a reorder.
	expect(await railOrder(page)).toEqual(initialOrder);
});

test('the rail auto-scrolls while dragging toward its bottom edge on an overflowing list', async ({
	page,
	sharedWorkspace,
}) => {
	// Synthetic clones (rather than 20 real projects) guarantee the rail overflows
	// whatever else is on this shared server. Their ids don't exist server-side, so
	// the drop's reorder call is stubbed — persistence is asserted in the first
	// test; what is under test here is only that the rail scrolls under the finger.
	await mockRailProjects(page, { keepSlug: sharedWorkspace.projectSlug, clones: 20 });
	await page.route('**/api/project-display-order', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ data: [] }),
		}),
	);

	await page.goto('/home');
	await waitForPageLoad(page);

	const scroller = page.getByTestId('project-rail-scroll');
	const avatars = scroller.locator('[data-testid^="project-rail-avatar-"]');
	await expect(avatars.first()).toBeVisible({ timeout: 15_000 });
	// The mocked index must actually overflow the rail for this test to mean anything.
	expect(await scroller.evaluate((el) => el.scrollHeight > el.clientHeight + 1)).toBe(true);

	const box = await scroller.boundingBox();
	const topBox = await avatars.first().boundingBox();
	if (!box || !topBox) throw new Error('missing layout boxes');

	await page.mouse.move(topBox.x + topBox.width / 2, topBox.y + topBox.height / 2);
	await page.mouse.down();
	// Park the pointer inside the bottom edge zone and let the rAF loop run.
	await page.mouse.move(topBox.x + topBox.width / 2, box.y + box.height - 4, { steps: 10 });
	await expect
		.poll(() => scroller.evaluate((el) => el.scrollTop), { timeout: 5_000 })
		.toBeGreaterThan(0);
	await page.mouse.up();
});
