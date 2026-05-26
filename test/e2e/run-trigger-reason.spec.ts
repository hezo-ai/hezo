import { expect, type Page, test } from '@playwright/test';
import {
	authenticate,
	createProjectReadyForAgents,
	createTeamWithAgents,
	waitForAgentIdle,
	waitForCaptainIdle,
} from './helpers';

interface RunListItem {
	id: string;
	status: string;
	trigger_source: string | null;
	trigger_actor_slug: string | null;
	trigger_comment_id: string | null;
	trigger_comment_task_identifier: string | null;
}

async function waitForRunWithTrigger(
	page: Page,
	teamId: string,
	agentId: string,
	token: string,
	predicate: (run: RunListItem) => boolean,
	timeoutMs = 240_000,
): Promise<RunListItem> {
	const headers = { Authorization: `Bearer ${token}` };
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const res = await page.request.get(`/api/teams/${teamId}/agents/${agentId}/heartbeat-runs`, {
			headers,
		});
		const body = (await res.json()) as { data: RunListItem[] };
		const match = body.data.find(
			(r) => predicate(r) && (r.status === 'succeeded' || r.status === 'failed'),
		);
		if (match) return match;
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error(`No matching run found within ${timeoutMs}ms`);
}

test('run page shows trigger reason linking back to the source mention', async ({ page }) => {
	await authenticate(page);
	const { team, token } = await createTeamWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	const agentsRes = await page.request.get(`/api/teams/${team.id}/agents`, { headers });
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const captain = agents.find((a) => a.slug === 'captain') ?? agents[0];
	const architect = agents.find((a) => a.slug === 'architect') ?? agents[1];

	await waitForCaptainIdle(page, team.id, token);

	const project = await createProjectReadyForAgents(page, team, token, {
		name: 'Trigger Reason Project',
		description: 'Test project.',
	});

	// Assign to the architect so the task's auto-assignment wakeup goes to a
	// different agent than the one we plan to wake via mention. That way the
	// architect's mention-driven run is unambiguous to find.
	const taskRes = await page.request.post(`/api/teams/${team.id}/tasks`, {
		headers,
		data: {
			project_id: project.id,
			title: 'Trigger reason test',
			description: 'Synthetic test task',
			assignee_id: architect.id,
		},
	});
	const task = ((await taskRes.json()) as { data: { id: string; identifier: string } }).data;

	// Let the assignee's assignment wakeup finish before waking Captain via mention.
	await waitForAgentIdle(page, team.id, architect.id, token);
	await waitForCaptainIdle(page, team.id, token);

	await page.request.post(`/api/teams/${team.id}/tasks/${task.id}/comments`, {
		headers,
		data: { content_type: 'text', content: { text: `@${captain.slug} please weigh in here` } },
	});

	const taskIdLower = task.identifier.toLowerCase();
	const mentionRun = await waitForRunWithTrigger(
		page,
		team.id,
		captain.id,
		token,
		(r) =>
			r.trigger_source === 'mention' &&
			r.trigger_comment_task_identifier?.toLowerCase() === taskIdLower,
	);

	await page.goto(`/teams/${team.slug}/agents/${captain.id}/executions/${mentionRun.id}`);

	const triggerRow = page.getByTestId('run-trigger-reason');
	await expect(triggerRow).toBeVisible({ timeout: 15000 });
	await expect(triggerRow).toContainText('Triggered by');

	const triggerLink = page.getByTestId('run-trigger-link');
	await expect(triggerLink).toBeVisible();
	// Label varies with whether the mentioner is an agent ("Mentioned by @x in IN-12")
	// or a board user ("Mentioned in a comment"); both are acceptable.
	await expect(triggerLink).toContainText(/Mentioned/);

	const href = await triggerLink.getAttribute('href');
	expect(href?.toLowerCase()).toContain(`/tasks/${task.identifier.toLowerCase()}`);
	expect(href).toContain('#comment-');
});

test('task link on run detail page scrolls to the run comment', async ({ page }) => {
	await authenticate(page);
	const { team, token } = await createTeamWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	const agentsRes = await page.request.get(`/api/teams/${team.id}/agents`, { headers });
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const architect = agents.find((a) => a.slug === 'architect') ?? agents[1];

	await waitForCaptainIdle(page, team.id, token);

	const project = await createProjectReadyForAgents(page, team, token, {
		name: 'Run Comment Deep Link Project',
		description: 'Test project.',
	});

	const taskRes = await page.request.post(`/api/teams/${team.id}/tasks`, {
		headers,
		data: {
			project_id: project.id,
			title: 'Run comment deep link test',
			description: 'Synthetic test task',
			assignee_id: architect.id,
		},
	});
	const task = ((await taskRes.json()) as { data: { id: string; identifier: string } }).data;

	const taskIdLower = task.identifier.toLowerCase();
	const assignmentRun = await waitForRunWithTrigger(
		page,
		team.id,
		architect.id,
		token,
		(r) => r.trigger_source === 'assignment',
	);

	await page.goto(`/teams/${team.slug}/agents/${architect.id}/executions/${assignmentRun.id}`);

	const taskLink = page.locator(`a[href*="/tasks/${taskIdLower}"]`).first();
	await expect(taskLink).toBeVisible({ timeout: 15000 });

	const href = await taskLink.getAttribute('href');
	expect(href).toMatch(/#comment-[0-9a-f-]{36}$/);
	const commentId = href!.split('#comment-')[1];

	await taskLink.click();

	// The task page strips the hash after scrolling, but flags the resolved
	// comment via `data-comment-highlighted="true"` for 2s — that's the
	// signal the deep-link actually landed on the right row.
	const commentEl = page.locator(`[id="comment-${commentId}"][data-comment-highlighted="true"]`);
	await expect(commentEl).toBeVisible({ timeout: 15000 });
	await expect(commentEl).toBeInViewport();
});

test('run list row shows the trigger reason summary', async ({ page }) => {
	await authenticate(page);
	const { team, token } = await createTeamWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	const agentsRes = await page.request.get(`/api/teams/${team.id}/agents`, { headers });
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const captain = agents.find((a) => a.slug === 'captain') ?? agents[0];

	await waitForCaptainIdle(page, team.id, token);

	const project = await createProjectReadyForAgents(page, team, token, {
		name: 'Trigger List Project',
		description: 'Test project.',
	});

	const taskRes = await page.request.post(`/api/teams/${team.id}/tasks`, {
		headers,
		data: {
			project_id: project.id,
			title: 'Trigger list test',
			description: 'Synthetic test task',
			assignee_id: captain.id,
		},
	});
	const task = ((await taskRes.json()) as { data: { id: string; identifier: string } }).data;

	// Wait for at least one terminal run on the assigned agent so the list page
	// has a row to render.
	await waitForRunWithTrigger(page, team.id, captain.id, token, (r) => r.trigger_source !== null);

	await page.goto(`/teams/${team.slug}/agents/${captain.id}/executions`);

	const firstRow = page.locator('a[href*="/executions/"]').first();
	await expect(firstRow).toBeVisible({ timeout: 15000 });
	// Any of the rendered sources should appear; the assignment wakeup
	// is the most reliable since it fires synchronously on task creation.
	await expect(firstRow).toContainText(
		/Assigned to|Mentioned by|Scheduled heartbeat|Manually started/,
	);
	expect((task as { identifier: string }).identifier).toBeTruthy();
});
