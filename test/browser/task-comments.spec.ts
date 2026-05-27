// Most task-comments coverage now lives in the component tier
// (`packages/web/test/task-comments.test.tsx`). These two tests stay in
// Playwright because they exercise behavior happy-dom doesn't model:
//   1. Virtuoso virtualization (mount window) and scroll-to-comment via URL hash
//   2. Reply flow at a mobile viewport width

import { expect, test } from './fixtures';
import {
	createProjectAndClearPlanning,
	uniqueName,
	waitForAgentIdle,
	waitForPageLoad,
} from './helpers';

type Page = import('@playwright/test').Page;
type Team = { id: string; slug: string };
type Agent = { id: string; slug: string };

async function createProjectAndTask(page: Page, team: Team, token: string, agents: Agent[]) {
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

	const projRes = await createProjectAndClearPlanning(page, team.id, token, {
		name: uniqueName('Comment Project'),
		description: 'Test project.',
	});
	const project = ((await projRes.json()) as any).data;

	const agent = agents[0];

	const taskRes = await page.request.post(`/api/teams/${team.id}/tasks`, {
		headers,
		data: { project_id: project.id, title: 'Comment Test Task', assignee_id: agent.id },
	});
	const task = ((await taskRes.json()) as any).data;

	await waitForAgentIdle(page, team.id, agent.id, token);

	return { team, token, project, task, agent, headers };
}

test.describe('Task Comments', () => {
	test('virtualizes a large comment thread and scrolls to deep-link target', async ({
		sharedPage: page,
		sharedWorkspace,
	}) => {
		test.setTimeout(60_000);
		const { team, task, headers } = await createProjectAndTask(
			page,
			sharedWorkspace.team,
			sharedWorkspace.token,
			sharedWorkspace.agents,
		);

		const TOTAL = 120;
		const created: { id: string; index: number }[] = [];
		const BATCH = 12;
		for (let start = 0; start < TOTAL; start += BATCH) {
			const batch = Array.from({ length: Math.min(BATCH, TOTAL - start) }, (_, i) => start + i);
			const results = await Promise.all(
				batch.map((i) =>
					page.request.post(`/api/teams/${team.id}/tasks/${task.id}/comments`, {
						headers,
						data: { content_type: 'text', content: { text: `seeded-comment-${i}` } },
					}),
				),
			);
			for (const [k, res] of results.entries()) {
				const json = (await res.json()) as { data: { id: string } };
				created.push({ id: json.data.id, index: batch[k] });
			}
		}

		await page.goto(`/teams/${team.slug}/tasks/${task.id}`);
		await waitForPageLoad(page);

		await expect(page.getByTestId('comments-list')).toBeVisible({ timeout: 20_000 });
		const items = page.getByTestId('comment-item');
		await expect(items.first()).toBeVisible({ timeout: 20_000 });

		await expect.poll(() => items.count(), { timeout: 10_000 }).toBeLessThan(TOTAL);
		await expect.poll(() => items.count()).toBeGreaterThan(0);
		await expect(page.getByText(`seeded-comment-${TOTAL - 1}`)).toHaveCount(0);
		await expect(page.getByText(`seeded-comment-${TOTAL - 5}`)).toHaveCount(0);

		const target = created[Math.floor(TOTAL / 2)];
		await page.goto(`/teams/${team.slug}/tasks/${task.id}#comment-${target.id}`);
		await waitForPageLoad(page);
		const anchored = page.locator(`#comment-${target.id}`);
		await expect(anchored).toBeVisible({ timeout: 20_000 });
		await expect(anchored).toContainText(`seeded-comment-${target.index}`);
	});

	test('reply flow works on mobile viewport', async ({ sharedPage: page, sharedWorkspace }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		const { team, task, headers } = await createProjectAndTask(
			page,
			sharedWorkspace.team,
			sharedWorkspace.token,
			sharedWorkspace.agents,
		);

		const parentRes = await page.request.post(`/api/teams/${team.id}/tasks/${task.id}/comments`, {
			headers,
			data: { content: 'Mobile parent comment' },
		});
		const parent = ((await parentRes.json()) as any).data;

		await page.goto(`/teams/${team.slug}/tasks/${task.id}`);
		await waitForPageLoad(page);

		const parentItem = page.locator(`#comment-${parent.id}`);
		await expect(parentItem).toBeVisible({ timeout: 20_000 });

		await parentItem.getByTestId('comment-reply').click();

		const composer = page.getByPlaceholder('Add a comment...');
		await expect(composer).toBeFocused();
		await expect(page.getByTestId('reply-indicator')).toBeVisible();

		await composer.fill('Mobile reply');
		await page.getByRole('button', { name: 'Comment', exact: true }).click();

		const followUp = page
			.locator('[data-testid="comment-item"]')
			.filter({ hasText: 'Mobile reply' });
		await expect(followUp).toBeVisible({ timeout: 15_000 });
		await expect(followUp.getByTestId('replying-to')).toBeVisible();
	});
});
