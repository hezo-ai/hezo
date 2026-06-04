// Most task-CRUD coverage now lives in the component tier
// (`packages/web/test/task-crud.test.tsx`). The one test that stays in
// Playwright is the Agent Queue running-row scroll-into-view path, because it
// asserts on `toBeInViewport()` which only a real browser layout engine can
// resolve.

import { expect, test } from './fixtures';
import { createProjectAndClearPlanning, uniqueName, waitForPageLoad } from './helpers';

test('Agent Queue running row links the agent name to its run comment and scrolls into view', async ({
	sharedPage: page,
	sharedWorkspace,
}) => {
	const { team, token, agents } = sharedWorkspace;
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

	const projectRes = await createProjectAndClearPlanning(page, team.id, token, {
		name: uniqueName('Running Link Project'),
		description: 'Test project.',
	});
	const project = (await projectRes.json()).data;
	const agent = agents[0] as { id: string; title: string };

	const taskRes = await page.request.post(`/api/teams/${team.id}/tasks`, {
		headers,
		data: { project_id: project.id, title: 'Linked Running Task', assignee_id: agent.id },
	});
	const task = (await taskRes.json()).data;

	const commentId = 'bbbb0000-0000-0000-0000-000000000001';
	const runId = 'cccc0000-0000-0000-0000-000000000001';
	const runComment = {
		id: commentId,
		task_id: task.id,
		content_type: 'run',
		content: { run_id: runId, agent_id: agent.id, agent_title: agent.title },
		chosen_option: null,
		created_at: new Date().toISOString(),
		author_type: 'agent',
		author_name: agent.title,
		author_member_id: agent.id,
	};

	// Drive the running row from a mocked lock rather than a real POST /lock:
	// creating an agent-assigned task posts a background wakeup whose cron can
	// acquire (and then roll back) the execution lock first, racing the test.
	// The row only reads the locks + comments queries, so mocking both keeps
	// this scroll-into-view assertion hermetic.
	const lock = {
		id: 'aaaa0000-0000-0000-0000-000000000001',
		task_id: task.id,
		member_id: agent.id,
		member_name: agent.title,
		locked_at: new Date().toISOString(),
	};

	const filler = Array.from({ length: 20 }, (_, i) => ({
		id: `dddd0000-0000-0000-0000-${String(i).padStart(12, '0')}`,
		task_id: task.id,
		content_type: 'text',
		content: { text: `Filler comment ${i} — lorem ipsum dolor sit amet.` },
		chosen_option: null,
		created_at: new Date(Date.now() - (30 - i) * 60_000).toISOString(),
		author_type: 'user',
		author_name: 'Board',
		author_member_id: null,
	}));

	await page.route(`**/api/teams/*/tasks/*/comments**`, async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ data: [...filler, runComment] }),
		});
	});

	await page.route(`**/api/teams/*/tasks/*/lock`, async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ data: { locks: [lock] } }),
		});
	});

	await page.goto(`/teams/${team.id}/tasks/${task.id}`);
	await waitForPageLoad(page);

	const agentQueue = page.getByTestId('agent-queue-section');
	await expect(agentQueue).toBeVisible({ timeout: 15000 });

	const link = agentQueue.getByRole('link', { name: agent.title });
	await expect(link).toHaveAttribute('href', `#comment-${commentId}`);

	const targetComment = page.locator(`#comment-${commentId}`);
	await expect(targetComment).not.toBeInViewport();

	await link.click();
	await expect(targetComment).toBeInViewport({ timeout: 15000 });
});
