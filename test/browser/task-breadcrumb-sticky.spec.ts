// Real CSS layout plus a viewport-conditional rule (testing decision tree,
// points 1 & 2): the breadcrumb's pinning is `position: sticky` resolving
// against the shell <main> scroller, asserted through `boundingBox()` before and
// after a real scroll; and the one-line guarantee is a layout fact - whether the
// segments share a line box, and whether the name truncated - which happy-dom
// cannot answer because it runs no layout pass and no media queries. The crumb's
// links, name and ancestor rendering stay covered by the component tests in
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

	const scrolled = await scrollMain(page, 600);
	expect(scrolled).toBeGreaterThan(300);

	// The phone is where the title leaves the screen soonest, so the crumb holds
	// its band here as well - carrying the name, not just the identifier.
	await expect(crumb).toBeInViewport();
	const after = await crumb.boundingBox();
	expect(after).not.toBeNull();
	if (before && after) expect(Math.abs(after.y - before.y)).toBeLessThan(30);
	await expect(crumb).toContainText(task.identifier);
	await expect(crumb).toHaveAttribute('data-pinned', 'true');
});

test('the crumb stays one line when a deep sub-task has a long name on a narrow phone', async ({
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
	const child = ((await childRes.json()) as { data: { identifier: string } }).data;

	await page.goto(`/projects/${project.slug}/tasks/${child.identifier.toLowerCase()}`);
	await waitForPageLoad(page);

	const crumb = page.getByTestId('task-breadcrumb');
	await expect(crumb).toBeVisible({ timeout: 20000 });

	// One line, stated structurally rather than as a pixel budget: every segment
	// that occupies flow shares a line box. Two lines would spread these tops by
	// a whole line-height.
	const topSpread = await crumb.evaluate((el) => {
		const tops = Array.from(el.children)
			.filter((kid) => {
				const cs = getComputedStyle(kid);
				return cs.position !== 'absolute' && cs.display !== 'none';
			})
			.map((kid) => kid.getBoundingClientRect().top);
		return Math.max(...tops) - Math.min(...tops);
	});
	expect(topSpread).toBeLessThan(2);

	// ...and it holds because the name gave way, not because this title happened
	// to fit: the browser really did cut it.
	const nameOverflow = await page
		.getByTestId('task-breadcrumb-title')
		.evaluate((el) => el.scrollWidth - el.clientWidth);
	expect(nameOverflow).toBeGreaterThan(0);

	// Below `sm` the ancestor identifiers give up their room to the name, leaving
	// the ellipsis in their place. The links stay in the accessibility tree.
	await expect(page.getByTestId('task-breadcrumb-ancestors-collapsed')).toBeVisible();
	await expect(page.getByTestId('task-breadcrumb-ancestor')).toBeAttached();
	await expect(page.getByTestId('task-breadcrumb-ancestor')).not.toBeInViewport();

	// Widen past `sm` and the chain comes back in place of the ellipsis - the
	// other half of the same rule, and the half no other test would catch if
	// `sm:not-sr-only` stopped resolving.
	await page.setViewportSize({ width: 1280, height: 800 });
	await expect(page.getByTestId('task-breadcrumb-ancestor')).toBeVisible();
	await expect(page.getByTestId('task-breadcrumb-ancestors-collapsed')).toBeHidden();
});
