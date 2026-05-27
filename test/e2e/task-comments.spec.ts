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
	test('task detail shows comments tab with count', async ({
		sharedPage: page,
		sharedWorkspace,
	}) => {
		const { team, task } = await createProjectAndTask(
			page,
			sharedWorkspace.team,
			sharedWorkspace.token,
			sharedWorkspace.agents,
		);

		await page.goto(`/teams/${team.slug}/tasks/${task.id}`);
		await waitForPageLoad(page);

		await expect(page.getByText('Comments')).toBeVisible({ timeout: 15000 });
	});

	test('can add a comment to an task', async ({ sharedPage: page, sharedWorkspace }) => {
		const { team, task } = await createProjectAndTask(
			page,
			sharedWorkspace.team,
			sharedWorkspace.token,
			sharedWorkspace.agents,
		);

		await page.goto(`/teams/${team.slug}/tasks/${task.id}`);
		await waitForPageLoad(page);

		const commentInput = page.getByPlaceholder('Add a comment...');
		await expect(commentInput).toBeVisible({ timeout: 20000 });
		await commentInput.fill('This is a test comment');

		await page.getByRole('button', { name: 'Comment', exact: true }).click();

		await expect(page.getByText('This is a test comment')).toBeVisible({ timeout: 15000 });
	});

	test('submits comment via Cmd/Ctrl+Enter shortcut', async ({
		sharedPage: page,
		sharedWorkspace,
	}) => {
		const { team, task } = await createProjectAndTask(
			page,
			sharedWorkspace.team,
			sharedWorkspace.token,
			sharedWorkspace.agents,
		);

		await page.goto(`/teams/${team.slug}/tasks/${task.id}`);
		await waitForPageLoad(page);

		const commentInput = page.getByPlaceholder('Add a comment...');
		await expect(commentInput).toBeVisible({ timeout: 20000 });
		await commentInput.fill('Submitted via keyboard');
		await commentInput.press('ControlOrMeta+Enter');

		await expect(page.getByText('Submitted via keyboard')).toBeVisible({ timeout: 15000 });
		await expect(commentInput).toHaveValue('');
	});

	test('comments persist after page reload', async ({ sharedPage: page, sharedWorkspace }) => {
		const { team, task, headers } = await createProjectAndTask(
			page,
			sharedWorkspace.team,
			sharedWorkspace.token,
			sharedWorkspace.agents,
		);

		await page.request.post(`/api/teams/${team.id}/tasks/${task.id}/comments`, {
			headers,
			data: { content: 'API-created comment' },
		});

		await page.goto(`/teams/${team.slug}/tasks/${task.id}`);
		await waitForPageLoad(page);

		await expect(page.getByText('API-created comment')).toBeVisible({ timeout: 15000 });
	});

	test('comment count updates after adding comment', async ({
		sharedPage: page,
		sharedWorkspace,
	}) => {
		const { team, task, headers } = await createProjectAndTask(
			page,
			sharedWorkspace.team,
			sharedWorkspace.token,
			sharedWorkspace.agents,
		);

		await page.request.post(`/api/teams/${team.id}/tasks/${task.id}/comments`, {
			headers,
			data: { content: 'First comment' },
		});
		await page.request.post(`/api/teams/${team.id}/tasks/${task.id}/comments`, {
			headers,
			data: { content: 'Second comment' },
		});

		await page.goto(`/teams/${team.slug}/tasks/${task.id}`);
		await waitForPageLoad(page);

		await expect(page.getByText('First comment')).toBeVisible({ timeout: 15000 });
		await expect(page.getByText('Second comment')).toBeVisible();
	});

	test('renders markdown in comment bodies and shows author label', async ({
		sharedPage: page,
		sharedWorkspace,
	}) => {
		const { team, task, headers } = await createProjectAndTask(
			page,
			sharedWorkspace.team,
			sharedWorkspace.token,
			sharedWorkspace.agents,
		);

		const markdownBody =
			'## Execution Plan\n\nFirst paragraph of the plan.\n\nSecond paragraph after a blank line.\n\n**Objective:** Ship it.\n\n- one\n- two';
		await page.request.post(`/api/teams/${team.id}/tasks/${task.id}/comments`, {
			headers,
			data: { content_type: 'text', content: { text: markdownBody } },
		});

		await page.goto(`/teams/${team.slug}/tasks/${task.id}`);
		await waitForPageLoad(page);

		const body = page.getByTestId('text-comment-body').first();
		await expect(body).toBeVisible({ timeout: 15000 });
		await expect(body.locator('h2')).toHaveText('Execution Plan');
		await expect(body.locator('strong')).toHaveText('Objective:');
		await expect(body.locator('li')).toHaveCount(2);
		await expect(body.locator('p')).toHaveCount(3);

		const author = page.getByTestId('comment-author').first();
		await expect(author).toBeVisible();
		await expect(author).toHaveText('Board');
	});

	test('effort dropdown marks the agent default and omits it from the submit body', async ({
		sharedPage: page,
		sharedWorkspace,
	}) => {
		const { team, task, agent } = await createProjectAndTask(
			page,
			sharedWorkspace.team,
			sharedWorkspace.token,
			sharedWorkspace.agents,
		);

		const expectedDefault =
			agent.slug === 'captain'
				? 'Max (ultrathink)'
				: {
						minimal: 'Minimal',
						low: 'Low',
						medium: 'Medium',
						high: 'High',
						max: 'Max (ultrathink)',
					}[(agent as any).default_effort as 'minimal' | 'low' | 'medium' | 'high' | 'max'];

		await page.goto(`/teams/${team.slug}/tasks/${task.id}`);
		await waitForPageLoad(page);

		const select = page.getByLabel('Reasoning effort for the agent run triggered by this comment');
		await expect(select).toBeVisible({ timeout: 20000 });

		const labels = await select.locator('option').allTextContents();
		const withSuffix = labels.filter((l) => l.endsWith(' (default)'));
		expect(withSuffix).toHaveLength(1);
		expect(withSuffix[0]).toBe(`${expectedDefault} (default)`);
		expect(labels).not.toContain('Default');

		const postBodies: Array<Record<string, unknown>> = [];
		page.on('request', (req) => {
			if (
				req.method() === 'POST' &&
				/\/api\/teams\/[^/]+\/tasks\/[^/]+\/comments$/.test(req.url())
			) {
				postBodies.push(req.postDataJSON());
			}
		});

		await page.getByPlaceholder('Add a comment...').fill('default-effort test');
		await page.getByRole('button', { name: 'Comment', exact: true }).click();
		await expect(page.getByText('default-effort test')).toBeVisible({ timeout: 15000 });

		expect(postBodies).toHaveLength(1);
		expect(postBodies[0]).not.toHaveProperty('effort');
	});

	test('agent mentions render as bold anchor-colored links to agent page', async ({
		sharedPage: page,
		sharedWorkspace,
	}) => {
		const { team, task, headers, agent } = await createProjectAndTask(
			page,
			sharedWorkspace.team,
			sharedWorkspace.token,
			sharedWorkspace.agents,
		);

		const body = `Hey @${agent.slug} please check this. Also @not-a-real-agent-xyz stays plain.`;
		await page.request.post(`/api/teams/${team.id}/tasks/${task.id}/comments`, {
			headers,
			data: { content_type: 'text', content: { text: body } },
		});

		await page.goto(`/teams/${team.slug}/tasks/${task.id}`);
		await waitForPageLoad(page);

		const comment = page.getByTestId('text-comment-body').first();
		await expect(comment).toBeVisible({ timeout: 15000 });

		const mentionLink = comment.getByTestId('agent-mention-link');
		await expect(mentionLink).toHaveText(`@${agent.slug}`);
		await expect(mentionLink).toHaveAttribute('href', `/teams/${team.slug}/agents/${agent.slug}`);
		await expect(mentionLink).toHaveClass(/font-semibold/);
		await expect(mentionLink).toHaveClass(/text-accent-blue-text/);

		await expect(comment).toContainText('@not-a-real-agent-xyz');
		await expect(comment.locator('a', { hasText: '@not-a-real-agent-xyz' })).toHaveCount(0);

		await mentionLink.click();
		await expect(page).toHaveURL(new RegExp(`/teams/${team.slug}/agents/${agent.slug}(/|$)`));
	});

	test('wake-assignee checkbox is visible, default-checked, and reflected in submit body', async ({
		sharedPage: page,
		sharedWorkspace,
	}) => {
		const { team, task } = await createProjectAndTask(
			page,
			sharedWorkspace.team,
			sharedWorkspace.token,
			sharedWorkspace.agents,
		);

		await page.goto(`/teams/${team.slug}/tasks/${task.id}`);
		await waitForPageLoad(page);

		const sidebar = page.getByTestId('task-sidebar');
		await expect(sidebar.getByRole('checkbox', { name: 'Wake assignee on submit' })).toHaveCount(0);

		const textarea = page.getByPlaceholder('Add a comment...');
		await expect(textarea).toBeVisible({ timeout: 20000 });
		const commentForm = textarea.locator('xpath=ancestor::form');
		const checkbox = commentForm.getByRole('checkbox', { name: 'Wake assignee on submit' });
		await expect(checkbox).toBeVisible();
		await expect(checkbox).toBeChecked();

		const postBodies: Array<Record<string, unknown>> = [];
		page.on('request', (req) => {
			if (
				req.method() === 'POST' &&
				/\/api\/teams\/[^/]+\/tasks\/[^/]+\/comments$/.test(req.url())
			) {
				postBodies.push(req.postDataJSON());
			}
		});

		const submit = page.getByRole('button', { name: 'Comment', exact: true });

		await textarea.fill('wake-assignee on');
		await submit.click();
		await expect(page.getByText('wake-assignee on')).toBeVisible({ timeout: 15000 });
		await expect(textarea).toHaveValue('');

		await expect(checkbox).toBeChecked();
		await checkbox.uncheck();
		await expect(checkbox).not.toBeChecked();
		await textarea.fill('wake-assignee off');
		await expect(textarea).toHaveValue('wake-assignee off');
		await submit.click();
		await expect(page.getByText('wake-assignee off')).toBeVisible({ timeout: 15000 });

		expect(postBodies).toHaveLength(2);
		expect(postBodies[0].wake_assignee).toBe(true);
		expect(postBodies[1].wake_assignee).toBe(false);

		await expect(checkbox).toBeChecked();
	});

	test('comment items render as bordered cards with a tinted header', async ({
		sharedPage: page,
		sharedWorkspace,
	}) => {
		const { team, task, headers } = await createProjectAndTask(
			page,
			sharedWorkspace.team,
			sharedWorkspace.token,
			sharedWorkspace.agents,
		);

		await page.request.post(`/api/teams/${team.id}/tasks/${task.id}/comments`, {
			headers,
			data: { content_type: 'text', content: { text: 'A boxed comment.' } },
		});

		await page.goto(`/teams/${team.slug}/tasks/${task.id}`);
		await waitForPageLoad(page);

		const item = page
			.getByTestId('comment-item')
			.filter({ has: page.getByText('A boxed comment.') })
			.first();
		await expect(item).toBeVisible({ timeout: 15000 });

		const card = item.locator('> div').nth(1);
		await expect(card).toHaveClass(/border/);
		await expect(card).toHaveClass(/rounded-md/);

		const header = card.locator('> div').first();
		await expect(header).toHaveClass(/bg-bg-muted/);
		await expect(header.getByTestId('comment-author')).toBeVisible();
	});

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

	test('reply icon focuses composer, shows in-response-to, and persists parent link', async ({
		sharedPage: page,
		sharedWorkspace,
	}) => {
		const { team, task, headers } = await createProjectAndTask(
			page,
			sharedWorkspace.team,
			sharedWorkspace.token,
			sharedWorkspace.agents,
		);

		const parentRes = await page.request.post(`/api/teams/${team.id}/tasks/${task.id}/comments`, {
			headers,
			data: { content: 'Original comment to reply to' },
		});
		const parent = ((await parentRes.json()) as any).data;

		await page.goto(`/teams/${team.slug}/tasks/${task.id}`);
		await waitForPageLoad(page);

		const parentItem = page.locator(`#comment-${parent.id}`);
		await expect(parentItem).toBeVisible({ timeout: 20_000 });

		await parentItem.getByTestId('comment-reply').click();

		const composer = page.getByPlaceholder('Add a comment...');
		await expect(composer).toBeFocused();

		const indicator = page.getByTestId('reply-indicator');
		await expect(indicator).toBeVisible();
		await expect(indicator).toContainText('In response to');
		await expect(indicator).toContainText('Original comment');

		await page.getByTestId('clear-reply').click();
		await expect(indicator).toHaveCount(0);

		await parentItem.getByTestId('comment-reply').click();
		await expect(indicator).toBeVisible();

		await composer.fill('Follow-up reply');
		await page.getByRole('button', { name: 'Comment', exact: true }).click();

		const followUp = page
			.locator('[data-testid="comment-item"]')
			.filter({ hasText: 'Follow-up reply' });
		await expect(followUp).toBeVisible({ timeout: 15_000 });
		const replyingTo = followUp.getByTestId('replying-to');
		await expect(replyingTo).toBeVisible();
		await expect(replyingTo).toContainText('replying to');
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
