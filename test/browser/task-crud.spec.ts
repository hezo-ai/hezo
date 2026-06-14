// Most task-CRUD coverage now lives in the component tier
// (`packages/web/test/task-crud.test.tsx`). The one test that stays in
// Playwright is the Agent Queue running-row scroll-into-view path, because it
// asserts on `toBeInViewport()` which only a real browser layout engine can
// resolve.

import { expect, test } from './fixtures';
import { createProjectAndClearPlanning, uniqueName, waitForPageLoad } from './helpers';

test('Agent Queue running row links the name to the agent page and the run indicator scrolls to the run comment', async ({
	sharedPage: page,
	sharedWorkspace,
}) => {
	const { token } = sharedWorkspace;
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

	const projectRes = await createProjectAndClearPlanning(page, '', token, {
		name: uniqueName('Running Link Project'),
		description: 'Test project.',
	});
	const project = (await projectRes.json()).data;

	const agentsRes = await page.request.get(`/api/projects/${project.slug}/agents`, { headers });
	const projectAgents = (
		(await agentsRes.json()) as { data: Array<{ id: string; slug: string; title: string }> }
	).data;
	const agent = (projectAgents.find((a) => a.slug === 'captain') ?? projectAgents[0]) as {
		id: string;
		slug: string;
		title: string;
	};

	const taskRes = await page.request.post(`/api/projects/${project.slug}/tasks`, {
		headers,
		data: { project_id: project.id, title: 'Linked Running Task', assignee_id: agent.id },
	});
	const task = (await taskRes.json()).data;

	const commentId = 'bbbb0000-0000-0000-0000-000000000001';
	// Deep-link anchors use the comment's public_id slug (a creation timestamp),
	// not the UUID; the mocked comment must carry it for the jump to resolve.
	const publicId = '20260614120000';
	const runId = 'cccc0000-0000-0000-0000-000000000001';
	const runComment = {
		id: commentId,
		public_id: publicId,
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
		public_id: `202606140000${String(i).padStart(2, '0')}`,
		task_id: task.id,
		content_type: 'text',
		content: { text: `Filler comment ${i} — lorem ipsum dolor sit amet.` },
		chosen_option: null,
		created_at: new Date(Date.now() - (30 - i) * 60_000).toISOString(),
		author_type: 'user',
		author_name: 'Board',
		author_member_id: null,
	}));

	await page.route(`**/api/projects/*/tasks/*/comments**`, async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ data: [...filler, runComment] }),
		});
	});

	await page.route(`**/api/projects/*/tasks/*/lock`, async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ data: { locks: [lock] } }),
		});
	});

	await page.goto(`/projects/${project.slug}/tasks/${task.id}`);
	await waitForPageLoad(page);

	const agentQueue = page.getByTestId('agent-queue-section');
	await expect(agentQueue).toBeVisible({ timeout: 15000 });

	// The agent name navigates to the agent's profile page.
	const nameLink = agentQueue.getByRole('link', { name: agent.title });
	await expect(nameLink).toHaveAttribute('href', `/projects/${project.slug}/agents/${agent.slug}`);

	// The running indicator jumps to — and scrolls in — the live run comment.
	const runLink = agentQueue.getByRole('link', { name: 'Jump to run' });
	await expect(runLink).toHaveAttribute('href', `#comment-${publicId}`);

	const targetComment = page.locator(`#comment-${publicId}`);
	await expect(targetComment).not.toBeInViewport();

	await runLink.click();
	await expect(targetComment).toBeInViewport({ timeout: 15000 });
});
