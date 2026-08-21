// Real CSS layout (testing decision tree, point 1): the breadcrumb's pinning is
// `position: sticky` resolving against the shell <main> scroller, asserted
// through `boundingBox()` before and after a real scroll; the handoff of the task
// name from the heading to the crumb turns on whether the heading is still
// visible, which is a geometry question; and the one-line guarantee is a layout
// fact - whether the segments share a line box, and whether the row overflows and
// scrolls. happy-dom answers none of these, because it runs no layout pass. The
// crumb's links and ancestor rendering stay covered by the component tests in
// packages/web/test/task-breadcrumb.test.tsx.

import { expect, test } from './fixtures';
import { createProjectAndClearPlanning, uniqueName, waitForPageLoad } from './helpers';

type Page = import('@playwright/test').Page;

/** Enough comments that the thread overflows <main> at both viewports. */
const COMMENT_COUNT = 30;

async function seedTaskWithLongThread(page: Page, token: string) {
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
	const projRes = await createProjectAndClearPlanning(page, '', token, {
		name: uniqueName('Breadcrumb Sticky'),
		description: 'Sticky breadcrumb test.',
	});
	const project = ((await projRes.json()) as { data: { id: string; slug: string } }).data;

	const agentsRes = await page.request.get(`/api/projects/${project.slug}/agents`, { headers });
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const assigneeId = (agents.find((a) => a.slug === 'captain') ?? agents[0]).id;

	const taskRes = await page.request.post(`/api/projects/${project.slug}/tasks`, {
		headers,
		data: { project_id: project.id, title: 'Task with a long thread', assignee_id: assigneeId },
	});
	const task = ((await taskRes.json()) as { data: { id: string; identifier: string } }).data;

	// Anything the assignee posts later appends at the bottom of the thread, so it
	// can only make the page taller - never move the crumb these tests measure.
	const BATCH = 10;
	for (let start = 0; start < COMMENT_COUNT; start += BATCH) {
		const batch = Array.from(
			{ length: Math.min(BATCH, COMMENT_COUNT - start) },
			(_, i) => start + i,
		);
		await Promise.all(
			batch.map((i) =>
				page.request.post(`/api/projects/${project.slug}/tasks/${task.id}/comments`, {
					headers,
					data: {
						content_type: 'text',
						content: { text: `seeded comment ${i}. ${'lorem ipsum '.repeat(8)}` },
					},
				}),
			),
		);
	}

	return { project, task };
}

/** Scrolls <main> and returns where it actually landed. */
async function scrollMain(page: Page, top: number): Promise<number> {
	const main = page.locator('main').first();
	await main.evaluate((el, y) => el.scrollTo({ top: y, behavior: 'instant' }), top);
	return main.evaluate((el) => el.scrollTop);
}

/**
 * How far apart the tops of the crumb's segments are. One line box means ~0; two
 * lines would spread them by a whole line-height.
 */
async function topSpreadOf(page: Page): Promise<number> {
	return page.getByTestId('task-breadcrumb').evaluate((el) => {
		const row = el.querySelector('[data-breadcrumb-content]');
		const tops = Array.from(row?.children ?? [])
			.filter((kid) => {
				const cs = getComputedStyle(kid);
				return cs.position !== 'absolute' && cs.display !== 'none';
			})
			.map((kid) => kid.getBoundingClientRect().top);
		return Math.max(...tops) - Math.min(...tops);
	});
}

/** How far the crumb could scroll sideways, and where it currently sits. */
async function crumbScroll(page: Page): Promise<{ max: number; left: number }> {
	return page
		.getByTestId('task-breadcrumb')
		.evaluate((el) => ({ max: el.scrollWidth - el.clientWidth, left: el.scrollLeft }));
}

/**
 * The name lives in exactly one place at a time, and that place is whichever one
 * the reader can see. Asserted together so a change that drops it from both - the
 * failure mode the offset in `usePinnedBandHeight` exists to prevent - cannot pass
 * as "the crumb is correct".
 */
async function expectNameCarriedOnce(page: Page, by: 'heading' | 'crumb') {
	const crumbName = page.getByTestId('task-breadcrumb-title');
	if (by === 'heading') {
		await expect(page.getByTestId('task-title')).toBeInViewport();
		await expect(crumbName).toHaveCount(0);
	} else {
		await expect(crumbName).toBeAttached();
		await expect(page.getByTestId('task-title')).not.toBeInViewport();
	}
}

test('desktop: the breadcrumb stays pinned to the top while the thread scrolls', async ({
	sharedPage: page,
	sharedWorkspace,
}) => {
	test.setTimeout(60_000);
	await page.setViewportSize({ width: 1280, height: 800 });
	const { project, task } = await seedTaskWithLongThread(page, sharedWorkspace.token);

	await page.goto(`/projects/${project.slug}/tasks/${task.identifier.toLowerCase()}`);
	await waitForPageLoad(page);

	const crumb = page.getByTestId('task-breadcrumb');
	await expect(crumb).toBeVisible({ timeout: 20000 });

	const before = await crumb.boundingBox();
	expect(before).not.toBeNull();
	// At rest the crumb carries no hairline - the page keeps its clean top edge -
	// and no name, because the heading right below it is still saying it.
	await expect(crumb).toHaveAttribute('data-pinned', 'false');
	await expectNameCarriedOnce(page, 'heading');

	const scrolled = await scrollMain(page, 600);
	// Proves the thread genuinely overflowed and we moved a meaningful amount.
	expect(scrolled).toBeGreaterThan(300);

	// Pinned: still on screen, and within a few px of where it started. Without
	// sticky it would be ~600px above the fold by now.
	await expect(crumb).toBeInViewport();
	const after = await crumb.boundingBox();
	expect(after).not.toBeNull();
	if (before && after) expect(Math.abs(after.y - before.y)).toBeLessThan(30);

	// The task's identifier is still readable while deep in the thread, and the
	// hairline is now drawn because content is passing underneath.
	await expect(crumb).toContainText(task.identifier);
	await expect(crumb).toHaveAttribute('data-pinned', 'true');

	// The heading has gone, so the crumb is carrying the name now.
	await expectNameCarriedOnce(page, 'crumb');
	await expect(crumb).toContainText('Task with a long thread');

	// Back at the top it lets go of the hairline, and hands the name back to the
	// heading rather than saying it twice.
	await scrollMain(page, 0);
	await expect(crumb).toHaveAttribute('data-pinned', 'false');
	await expectNameCarriedOnce(page, 'heading');
});

test('mobile: the breadcrumb stays pinned too', async ({ sharedPage: page, sharedWorkspace }) => {
	test.setTimeout(60_000);
	await page.setViewportSize({ width: 375, height: 800 });
	const { project, task } = await seedTaskWithLongThread(page, sharedWorkspace.token);

	await page.goto(`/projects/${project.slug}/tasks/${task.identifier.toLowerCase()}`);
	await waitForPageLoad(page);

	const crumb = page.getByTestId('task-breadcrumb');
	await expect(crumb).toBeVisible({ timeout: 20000 });

	const before = await crumb.boundingBox();
	expect(before).not.toBeNull();
	await expect(crumb).toHaveAttribute('data-pinned', 'false');
	await expectNameCarriedOnce(page, 'heading');

	const scrolled = await scrollMain(page, 600);
	expect(scrolled).toBeGreaterThan(300);

	// The phone is where the title leaves the screen soonest, so the crumb holds
	// its band here as well - and picks up the name, which is the whole point of
	// holding it.
	await expect(crumb).toBeInViewport();
	const after = await crumb.boundingBox();
	expect(after).not.toBeNull();
	if (before && after) expect(Math.abs(after.y - before.y)).toBeLessThan(30);
	await expect(crumb).toContainText(task.identifier);
	await expect(crumb).toHaveAttribute('data-pinned', 'true');
	await expectNameCarriedOnce(page, 'crumb');
});

test('the crumb scrolls sideways rather than wrapping or hiding a segment at 320px', async ({
	sharedPage: page,
	sharedWorkspace,
}) => {
	test.setTimeout(60_000);
	// 320px is the narrowest viewport the UX rules cover, so it is the width at
	// which a wrapping crumb would first show itself.
	await page.setViewportSize({ width: 320, height: 800 });
	const headers = {
		Authorization: `Bearer ${sharedWorkspace.token}`,
		'Content-Type': 'application/json',
	};
	const projRes = await createProjectAndClearPlanning(page, '', sharedWorkspace.token, {
		name: uniqueName('Breadcrumb One Line'),
		description: 'One-line breadcrumb test.',
	});
	const project = ((await projRes.json()) as { data: { id: string; slug: string } }).data;

	const agentsRes = await page.request.get(`/api/projects/${project.slug}/agents`, { headers });
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const assigneeId = (agents.find((a) => a.slug === 'captain') ?? agents[0]).id;

	const parentRes = await page.request.post(`/api/projects/${project.slug}/tasks`, {
		headers,
		data: { project_id: project.id, title: 'Parent task', assignee_id: assigneeId },
	});
	const parent = ((await parentRes.json()) as { data: { id: string } }).data;
	const longTitle =
		'Refuse to start when a removed env var still selects the data directory, and name what replaced it';
	const childRes = await page.request.post(
		`/api/projects/${project.slug}/tasks/${parent.id}/sub-tasks`,
		{ headers, data: { title: longTitle, assignee_id: assigneeId } },
	);
	const child = ((await childRes.json()) as { data: { id: string; identifier: string } }).data;
	// Enough thread that <main> overflows at this viewport, so the heading can
	// actually be scrolled away and hand the name over.
	await Promise.all(
		Array.from({ length: 15 }, (_, i) =>
			page.request.post(`/api/projects/${project.slug}/tasks/${child.id}/comments`, {
				headers,
				data: {
					content_type: 'text',
					content: { text: `seeded comment ${i}. ${'lorem ipsum '.repeat(8)}` },
				},
			}),
		),
	);

	await page.goto(`/projects/${project.slug}/tasks/${child.identifier.toLowerCase()}`);
	await waitForPageLoad(page);

	const crumb = page.getByTestId('task-breadcrumb');
	await expect(crumb).toBeVisible({ timeout: 20000 });

	// One line, stated structurally rather than as a pixel budget: every segment
	// that occupies flow shares a line box. Two lines would spread these tops by
	// a whole line-height.
	expect(await topSpreadOf(page)).toBeLessThan(2);

	// Every ancestor is a real, reachable link at this width - there is no `sm`
	// collapse standing in for the chain, and nothing is left screen-reader-only.
	const ancestors = page.getByTestId('task-breadcrumb-ancestor');
	await expect(ancestors).toHaveCount(1);
	await expect(ancestors.first()).toBeInViewport();
	await expect(page.getByTestId('task-breadcrumb-tasks')).toBeInViewport();

	// A sideways swipe belongs to the row, never to the browser's back gesture.
	await expect(crumb).toHaveCSS('overscroll-behavior-x', 'contain');

	// Carrying the identifier alone, this chain fits even here. Scroll the heading
	// away and the row takes on a name far longer than the viewport - which is the
	// width at which a row that truncated instead of scrolling would lose it.
	expect(await scrollMain(page, 600)).toBeGreaterThan(300);
	await expectNameCarriedOnce(page, 'crumb');

	const grown = await crumbScroll(page);
	expect(grown.max).toBeGreaterThan(0);
	// Anchored to the end as it grew, so the name is what the phone shows rather
	// than the part of the trail the reader already knows.
	expect(grown.left).toBeGreaterThan(0);
	await expect(page.getByTestId('task-breadcrumb-title')).toBeInViewport();

	// ...and the start of the trail is still reachable the other way, so nothing
	// is stranded at the narrowest width the UX rules cover.
	await crumb.evaluate((el) => {
		el.scrollTo({ left: 0, behavior: 'instant' });
	});
	await expect(page.getByTestId('task-breadcrumb-tasks')).toBeInViewport();
	await expect(ancestors.first()).toBeInViewport();

	// Still one line with the name aboard - the row grew sideways, not downwards.
	expect(await topSpreadOf(page)).toBeLessThan(2);
});
