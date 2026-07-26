// Decision-tree points 2 + 3: the touch path cannot be synthesized by the test
// runner's mouse — `use-sortable-rail` branches on `pointerType === 'touch'` to
// pick long-press activation over the mouse threshold, and only real Chromium
// touch events (dispatched over CDP, with `hasTouch` on the context) produce
// that pointer type. happy-dom has neither touch events nor layout, so the
// ordering contract and the keyboard path live in
// packages/web/test/project-rail-reorder.test.tsx instead.

import type { CDPSession, Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import {
	createProjectAndClearPlanning,
	scopeRailToProjects,
	uniqueName,
	waitForPageLoad,
} from './helpers';

// Touch events only reach the page when the context advertises touch support.
test.use({ hasTouch: true });

/** How long `use-sortable-rail` waits before a press becomes a drag (LONG_PRESS_MS). */
const LONG_PRESS_MS = 250;

async function touchDrag(
	page: Page,
	from: { x: number; y: number },
	to: { x: number; y: number },
	options: { holdMs: number },
): Promise<void> {
	const client: CDPSession = await page.context().newCDPSession(page);
	try {
		await client.send('Input.dispatchTouchEvent', {
			type: 'touchStart',
			touchPoints: [{ x: from.x, y: from.y }],
		});
		if (options.holdMs > 0) await page.waitForTimeout(options.holdMs);
		const steps = 10;
		for (let i = 1; i <= steps; i++) {
			await client.send('Input.dispatchTouchEvent', {
				type: 'touchMove',
				touchPoints: [
					{
						x: from.x + ((to.x - from.x) * i) / steps,
						y: from.y + ((to.y - from.y) * i) / steps,
					},
				],
			});
		}
		await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	} finally {
		await client.detach().catch(() => {});
	}
}

/**
 * The drawer's rail. Below `md` the persistent rail is `display: none` rather
 * than unmounted, so both rails are in the DOM and every unscoped rail locator
 * would match twice.
 */
function drawerRail(page: Page): Locator {
	return page.getByTestId('mobile-nav-drawer').getByTestId('project-rail-scroll');
}

/** The drawer rail's avatar slugs, top to bottom. */
async function railOrder(page: Page): Promise<string[]> {
	return drawerRail(page)
		.locator('[data-testid^="project-rail-avatar-"]')
		.evaluateAll((els) =>
			els.map((el) => el.getAttribute('data-testid')?.replace('project-rail-avatar-', '') ?? ''),
		);
}

/** Box of one avatar in the drawer rail, by slug. */
async function avatarBox(page: Page, slug: string) {
	const box = await drawerRail(page)
		.locator(`[data-testid="project-rail-avatar-${slug}"]`)
		.boundingBox();
	if (!box) throw new Error(`missing layout box for ${slug}`);
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Three real projects, the rail scoped to them, and the mobile drawer open. */
async function openDrawerWithProjects(page: Page, token: string, label: string) {
	const projects = [];
	for (const suffix of ['A', 'B', 'C']) {
		projects.push(
			await createProjectAndClearPlanning(page, '', token, {
				name: uniqueName(`${label} ${suffix}`),
				description: 'E2E mobile project-rail reordering.',
			}),
		);
	}
	await scopeRailToProjects(
		page,
		projects.map((p) => p.slug),
	);

	await page.goto('/home');
	await waitForPageLoad(page);
	// Below `md` the rail only exists inside the side drawer.
	await page.getByTestId('mobile-nav-toggle').click();
	await expect(page.getByTestId('mobile-nav-drawer')).toBeVisible({ timeout: 15_000 });
	await expect(drawerRail(page).locator('[data-testid^="project-rail-avatar-"]')).toHaveCount(3, {
		timeout: 15_000,
	});

	// Each project is created on top of the last, so the rail is C, B, A.
	return { projects, initialOrder: [projects[2].slug, projects[1].slug, projects[0].slug] };
}

test('a quick touch-drag on an avatar is a scroll, not a reorder', async ({
	page,
	sharedWorkspace,
}) => {
	const { initialOrder } = await openDrawerWithProjects(
		page,
		sharedWorkspace.token,
		'Touch Scroll',
	);
	expect(await railOrder(page)).toEqual(initialOrder);

	let reorderCalls = 0;
	page.on('request', (r) => {
		if (new URL(r.url()).pathname === '/api/project-display-order') reorderCalls++;
	});

	const first = await avatarBox(page, initialOrder[0]);
	const last = await avatarBox(page, initialOrder[2]);

	// No hold: the finger moves straight away, which the hook must read as a scroll.
	await touchDrag(page, first, last, { holdMs: 0 });

	await page.waitForTimeout(500);
	expect(reorderCalls).toBe(0);
	expect(await railOrder(page)).toEqual(initialOrder);
});

test('press-and-hold then drag reorders the rail on touch', async ({ page, sharedWorkspace }) => {
	const { initialOrder } = await openDrawerWithProjects(page, sharedWorkspace.token, 'Touch Hold');
	expect(await railOrder(page)).toEqual(initialOrder);

	const first = await avatarBox(page, initialOrder[0]);
	const last = await avatarBox(page, initialOrder[2]);

	const savePut = page.waitForResponse(
		(r) =>
			new URL(r.url()).pathname === '/api/project-display-order' && r.request().method() === 'PUT',
	);
	await touchDrag(page, first, last, { holdMs: LONG_PRESS_MS + 150 });
	expect((await savePut).status()).toBe(200);

	await expect
		.poll(() => railOrder(page))
		.toEqual([initialOrder[1], initialOrder[2], initialOrder[0]]);
});

test('a tap on an avatar still opens the project', async ({ page, sharedWorkspace }) => {
	const { initialOrder } = await openDrawerWithProjects(page, sharedWorkspace.token, 'Touch Tap');

	const box = await avatarBox(page, initialOrder[0]);
	await page.touchscreen.tap(box.x, box.y);

	await expect(page).toHaveURL(new RegExp(`/projects/${initialOrder[0]}(/|$)`));
});
