// Scroll-reset-on-navigation is a real-CSS-layout assertion (testing decision
// tree, point 1): it turns on the shell <main> element's actual scrollTop /
// scrollHeight after an in-app navigation, values happy-dom can't compute. So
// this lives in Playwright rather than a component test.
//
// The bug: <main> is the single shell scroller and never unmounts across route
// changes (only the <Outlet> content swaps), so its scrollTop persisted from one
// page to the next — opening a fresh page landed scrolled to wherever the
// previous one was left.
//
// Two things make this catch the regression rather than pass trivially:
//   1. The destination (tasks list) is reached via SPA navigation, never a full
//      reload — a reload would remount <main> and reset scroll on its own.
//   2. The destination renders its tall content *synchronously* from the React
//      Query cache (warmed by the initial visit, no reload in between). An
//      uncached page flashes a short loading state that clamps scrollTop to 0 by
//      itself, which would hide the bug. The post-nav scrollHeight assertion
//      proves the list genuinely overflows, so a preserved scroll would be > 0.

import { expect, test } from './fixtures';
import { createProjectAndClearPlanning, uniqueName, waitForPageLoad } from './helpers';

type Page = import('@playwright/test').Page;

async function createProjectViaApi(page: Page, token: string, name: string) {
	const res = await createProjectAndClearPlanning(page, '', token, {
		name,
		description: 'Scroll-reset navigation test.',
	});
	const project = ((await res.json()) as { data: { id: string; slug: string } }).data;
	const agentsRes = await page.request.get(`/api/projects/${project.slug}/agents`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const assigneeId = (agents.find((a) => a.slug === 'captain') ?? agents[0]).id;
	return { ...project, assigneeId };
}

test('resets shell scroll to the top when navigating between pages', async ({
	page,
	sharedWorkspace,
}) => {
	const { token } = sharedWorkspace;
	// Desktop width keeps the project sidebar (lg:block) mounted for the SPA nav
	// click; a modest height makes both pages overflow without seeding huge data.
	await page.setViewportSize({ width: 1280, height: 600 });
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

	const project = await createProjectViaApi(page, token, uniqueName('Scroll Reset'));

	// Enough tasks that the task LIST overflows <main> — this is the navigation
	// destination whose scroll must reset.
	const sourceRes = await page.request.post(`/api/projects/${project.slug}/tasks`, {
		headers,
		data: {
			project_id: project.id,
			title: 'Source task with comments',
			assignee_id: project.assigneeId,
		},
	});
	const sourceTask = ((await sourceRes.json()) as { data: { id: string; identifier: string } })
		.data;
	for (let i = 0; i < 24; i++) {
		await page.request.post(`/api/projects/${project.slug}/tasks`, {
			headers,
			data: { project_id: project.id, title: `Filler task ${i}`, assignee_id: project.assigneeId },
		});
	}

	// Enough comments that the source task's detail page overflows <main> — this
	// is the page we scroll down before navigating away.
	for (let i = 0; i < 24; i++) {
		await page.request.post(`/api/projects/${project.slug}/tasks/${sourceTask.id}/comments`, {
			headers,
			data: {
				content_type: 'text',
				content: { text: `Source comment ${i}. ${'lorem '.repeat(30)}` },
			},
		});
	}

	// Initial load warms the task-list React Query cache so the return navigation
	// later renders the tall list synchronously (no loading-state self-clamp).
	await page.goto(`/projects/${project.slug}/tasks`);
	await waitForPageLoad(page);
	await expect(page.getByTestId('task-list-main')).toBeVisible({ timeout: 20000 });

	const main = page.locator('main').first();
	await expect
		.poll(() => main.evaluate((el) => el.scrollHeight > el.clientHeight), { timeout: 10000 })
		.toBe(true);

	// SPA-navigate into the comment-heavy task (clicking the row, NOT page.goto,
	// keeps the warmed task-list cache), wait for it to grow tall, then scroll it.
	await page.getByRole('row', { name: /Source task with comments/ }).click();
	await expect(page.getByPlaceholder('Add a comment...')).toBeVisible({ timeout: 20000 });
	await expect
		.poll(() => main.evaluate((el) => el.scrollHeight > el.clientHeight), { timeout: 10000 })
		.toBe(true);

	await main.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
	await expect
		.poll(() => main.evaluate((el) => el.scrollTop), { timeout: 10000 })
		.toBeGreaterThan(100);

	// SPA-navigate back to the (cached, tall) task list via the sidebar link.
	await page.getByTestId('project-sidebar-tasks').click();
	await expect(page.getByTestId('task-list-main')).toBeVisible({ timeout: 20000 });

	// The list still overflows, so without the reset the carried-over scrollTop
	// would remain > 0. With the fix it lands back at the top.
	expect(await main.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
	await expect.poll(() => main.evaluate((el) => el.scrollTop), { timeout: 10000 }).toBe(0);
});
