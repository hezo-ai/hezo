// Real CSS layout plus a viewport-conditional rule (testing decision tree,
// points 1 & 2): the breadcrumb's pinning is `position: sticky` resolving
// against the shell <main> scroller, asserted through `boundingBox()` before and
// after a real scroll, and it is deliberately desktop-only, which happy-dom
// cannot decide because it runs no media queries against a layout pass. The
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
	// At rest the crumb carries no hairline - the page keeps its clean top edge.
	await expect(crumb).toHaveAttribute('data-pinned', 'false');

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

	// Back at the top it lets go of the hairline again.
	await scrollMain(page, 0);
	await expect(crumb).toHaveAttribute('data-pinned', 'false');
});

test('mobile: the breadcrumb scrolls away with the page', async ({
	sharedPage: page,
	sharedWorkspace,
}) => {
	test.setTimeout(60_000);
	await page.setViewportSize({ width: 375, height: 800 });
	const { project, task } = await seedTaskWithLongThread(page, sharedWorkspace.token);

	await page.goto(`/projects/${project.slug}/tasks/${task.identifier.toLowerCase()}`);
	await waitForPageLoad(page);

	const crumb = page.getByTestId('task-breadcrumb');
	await expect(crumb).toBeVisible({ timeout: 20000 });

	const before = await crumb.boundingBox();
	expect(before).not.toBeNull();

	const scrolled = await scrollMain(page, 600);
	expect(scrolled).toBeGreaterThan(300);

	// Vertical space is the scarce thing on a phone, so the crumb goes with the
	// rest of the page rather than holding a band at the top.
	await expect(crumb).not.toBeInViewport();
	const after = await crumb.boundingBox();
	if (before && after) expect(after.y).toBeLessThan(before.y - 300);
});
