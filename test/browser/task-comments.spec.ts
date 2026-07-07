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

async function createProjectAndTask(page: Page, token: string) {
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

	const projRes = await createProjectAndClearPlanning(page, '', token, {
		name: uniqueName('Comment Project'),
		description: 'Test project.',
	});
	const project = ((await projRes.json()) as any).data;

	const agentsRes = await page.request.get(`/api/projects/${project.slug}/agents`, { headers });
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const agent = agents.find((a) => a.slug === 'captain') ?? agents[0];

	const taskRes = await page.request.post(`/api/projects/${project.slug}/tasks`, {
		headers,
		data: { project_id: project.id, title: 'Comment Test Task', assignee_id: agent.id },
	});
	const task = ((await taskRes.json()) as any).data;

	await waitForAgentIdle(page, project.team_slug, agent.id, token);

	return { token, project, task, agent, headers };
}

test.describe('Task Comments', () => {
	test('virtualizes a large comment thread and scrolls to deep-link target', async ({
		sharedPage: page,
		sharedWorkspace,
	}) => {
		test.setTimeout(60_000);
		const { task, project, headers } = await createProjectAndTask(page, sharedWorkspace.token);

		const TOTAL = 120;
		const created: { id: string; public_id: string; index: number }[] = [];
		const BATCH = 12;
		for (let start = 0; start < TOTAL; start += BATCH) {
			const batch = Array.from({ length: Math.min(BATCH, TOTAL - start) }, (_, i) => start + i);
			const results = await Promise.all(
				batch.map((i) =>
					page.request.post(`/api/projects/${project.slug}/tasks/${task.id}/comments`, {
						headers,
						data: { content_type: 'text', content: { text: `seeded-comment-${i}` } },
					}),
				),
			);
			for (const [k, res] of results.entries()) {
				const json = (await res.json()) as { data: { id: string; public_id: string } };
				created.push({ id: json.data.id, public_id: json.data.public_id, index: batch[k] });
			}
		}

		await page.goto(`/projects/${project.slug}/tasks/${task.id}`);
		await waitForPageLoad(page);

		await expect(page.getByTestId('comments-list')).toBeVisible({ timeout: 20_000 });
		const items = page.getByTestId('comment-item');
		await expect(items.first()).toBeVisible({ timeout: 20_000 });

		await expect.poll(() => items.count(), { timeout: 10_000 }).toBeLessThan(TOTAL);
		await expect.poll(() => items.count()).toBeGreaterThan(0);
		await expect(page.getByText(`seeded-comment-${TOTAL - 1}`)).toHaveCount(0);
		await expect(page.getByText(`seeded-comment-${TOTAL - 5}`)).toHaveCount(0);

		const target = created[Math.floor(TOTAL / 2)];
		await page.goto(
			`/projects/${project.slug}/tasks/${task.identifier.toLowerCase()}#comment-${target.public_id}`,
		);
		await waitForPageLoad(page);
		const anchored = page.locator(`#comment-${target.public_id}`);
		await expect(anchored).toBeVisible({ timeout: 20_000 });
		await expect(anchored).toContainText(`seeded-comment-${target.index}`);
	});

	test('reply flow works on mobile viewport', async ({ sharedPage: page, sharedWorkspace }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		const { task, project, headers } = await createProjectAndTask(page, sharedWorkspace.token);

		const parentRes = await page.request.post(
			`/api/projects/${project.slug}/tasks/${task.id}/comments`,
			{
				headers,
				data: { content: 'Mobile parent comment' },
			},
		);
		const parent = ((await parentRes.json()) as any).data;

		await page.goto(`/projects/${project.slug}/tasks/${task.id}`);
		await waitForPageLoad(page);

		const parentItem = page.locator(`#comment-${parent.public_id}`);
		await expect(parentItem).toBeVisible({ timeout: 20_000 });

		await parentItem.getByTestId('comment-reply').click();

		const composer = page.getByPlaceholder('Add a comment...');
		await expect(composer).toBeFocused();
		await expect(page.getByTestId('reply-indicator')).toBeVisible();

		await composer.fill('Mobile reply');
		// Replying to a human-authored parent wakes no one, so submitting won't
		// spawn a synthetic Captain run that would post a run comment and re-render
		// the thread while we wait for the reply below. The reply is what we assert.
		await page.getByRole('button', { name: 'Comment', exact: true }).click();

		const followUp = page
			.locator('[data-testid="comment-item"]')
			.filter({ hasText: 'Mobile reply' });
		// The reply appears once the create-comment POST resolves (its onSuccess
		// seeds the cache). On the single-connection e2e PGlite that POST can queue
		// behind other parallel workers' requests, so allow the same generous window
		// the rest of these specs use rather than letting a saturation spike flake.
		await expect(followUp).toBeVisible({ timeout: 20_000 });
		await expect(followUp.getByTestId('replying-to')).toBeVisible();
	});
});
