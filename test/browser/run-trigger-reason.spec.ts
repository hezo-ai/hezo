// Criterion #1 (real CSS layout): the deep link from a run back to its source
// comment is only meaningful if the viewport actually moves, so the assertion
// reads `main`'s live scrollTop after the deep-link navigation and requires it to
// be non-zero. happy-dom neither lays the page out nor scrolls it, so scrollTop
// would read 0 whether the deep link worked or not.
import { expect, type Page, test } from '@playwright/test';
import {
	authenticate,
	createProjectReadyForAgents,
	getToken,
	waitForAgentIdle,
	waitForCaptainIdle,
} from './helpers';

type ReadyProject = {
	id: string;
	slug: string;
	team_id: string;
	team_slug: string;
};

async function listProjectAgents(
	page: Page,
	projectSlug: string,
	token: string,
): Promise<Array<{ id: string; slug: string }>> {
	const res = await page.request.get(`/api/projects/${projectSlug}/agents`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	return ((await res.json()) as { data: Array<{ id: string; slug: string }> }).data;
}

async function createStartupProject(
	page: Page,
	token: string,
	name: string,
): Promise<ReadyProject> {
	return (await createProjectReadyForAgents(page, { id: '', slug: '' }, token, {
		name,
		description: 'Test project.',
		marketplace_slug: 'software-development',
	})) as unknown as ReadyProject;
}

interface RunListItem {
	id: string;
	status: string;
	task_id: string | null;
	trigger_source: string | null;
	trigger_actor_slug: string | null;
	trigger_comment_id: string | null;
	trigger_comment_task_identifier: string | null;
}

async function waitForRunWithTrigger(
	page: Page,
	projectSlug: string,
	agentId: string,
	token: string,
	predicate: (run: RunListItem) => boolean,
	timeoutMs = 240_000,
): Promise<RunListItem> {
	const headers = { Authorization: `Bearer ${token}` };
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const res = await page.request.get(
			`/api/projects/${projectSlug}/agents/${agentId}/heartbeat-runs`,
			{
				headers,
			},
		);
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
	const token = await getToken(page);
	const headers = { Authorization: `Bearer ${token}` };

	const project = await createStartupProject(page, token, 'Trigger Reason Project');

	const agents = await listProjectAgents(page, project.slug, token);
	const captain = agents.find((a) => a.slug === 'captain') ?? agents[0];
	const architect = agents.find((a) => a.slug === 'architect') ?? agents[1];

	// Assign to the architect so the task's auto-assignment wakeup goes to a
	// different agent than the one we plan to wake via mention. That way the
	// architect's mention-driven run is unambiguous to find.
	const taskRes = await page.request.post(`/api/projects/${project.slug}/tasks`, {
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
	await waitForAgentIdle(page, project.team_slug, architect.id, token);
	await waitForCaptainIdle(page, project.team_slug, token);

	await page.request.post(`/api/projects/${project.slug}/tasks/${task.id}/comments`, {
		headers,
		data: { content_type: 'text', content: { text: `@${captain.slug} please weigh in here` } },
	});

	const taskIdLower = task.identifier.toLowerCase();
	const mentionRun = await waitForRunWithTrigger(
		page,
		project.slug,
		captain.id,
		token,
		(r) =>
			r.trigger_source === 'mention' &&
			r.trigger_comment_task_identifier?.toLowerCase() === taskIdLower,
	);

	await page.goto(`/projects/${project.slug}/agents/${captain.id}/executions/${mentionRun.id}`);

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
	const token = await getToken(page);
	const headers = { Authorization: `Bearer ${token}` };

	const project = await createStartupProject(page, token, 'Run Comment Deep Link Project');

	const agents = await listProjectAgents(page, project.slug, token);
	const architect = agents.find((a) => a.slug === 'architect') ?? agents[1];

	// Pad the description so the comment list sits well below the fold — the
	// scroll has to actually move for the run comment to be visible.
	const longDescription = Array.from(
		{ length: 40 },
		(_, i) => `Line ${i + 1}: synthetic padding so the task header pushes the comments off-screen.`,
	).join('\n\n');

	const taskRes = await page.request.post(`/api/projects/${project.slug}/tasks`, {
		headers,
		data: {
			project_id: project.id,
			title: 'Run comment deep link test',
			description: longDescription,
			assignee_id: architect.id,
		},
	});
	const task = ((await taskRes.json()) as { data: { id: string; identifier: string } }).data;

	const taskIdLower = task.identifier.toLowerCase();
	// Match by task_id instead of trigger_source: a frequent test-mode heartbeat
	// cron (every 1s) can race the assignment wakeup — the first heartbeat fires
	// before the assignment wakeup is claimed, picks up the only actionable task
	// (this one), succeeds, and `assignmentWakeupAlreadyServed` then retires the
	// assignment wakeup as redundant. The deep-link being tested works for any
	// run on this task since every run posts a run_comment_id back to it.
	const taskRun = await waitForRunWithTrigger(
		page,
		project.slug,
		architect.id,
		token,
		(r) => r.task_id === task.id,
	);

	await page.goto(`/projects/${project.slug}/agents/${architect.id}/executions/${taskRun.id}`);

	const taskLink = page.locator(`a[href*="/tasks/${taskIdLower}"]`).first();
	await expect(taskLink).toBeVisible({ timeout: 15000 });

	const href = await taskLink.getAttribute('href');
	expect(href).toMatch(/#comment-\d{14}(?:-\d+)?$/);
	const commentId = href!.split('#comment-')[1];

	await taskLink.click();

	// The task page strips the hash after scrolling, but flags the resolved
	// comment via `data-comment-highlighted="true"` for 2s — that's the
	// signal the deep-link actually landed on the right row.
	const commentEl = page.locator(`[id="comment-${commentId}"][data-comment-highlighted="true"]`);
	await expect(commentEl).toBeVisible({ timeout: 15000 });
	await expect(commentEl).toBeInViewport();

	// The padded description makes the comment off-screen at the natural
	// scroll-top, so a non-zero scrollTop is what proves the page actually
	// moved to land on the comment (vs. the highlight being set on a row
	// that happens to still be off-screen).
	const scrollTop = await page.evaluate(() => document.querySelector('main')?.scrollTop ?? 0);
	expect(scrollTop).toBeGreaterThan(100);
});

test('run list row shows the trigger reason summary', async ({ page }) => {
	await authenticate(page);
	const token = await getToken(page);
	const headers = { Authorization: `Bearer ${token}` };

	const project = await createStartupProject(page, token, 'Trigger List Project');

	const agents = await listProjectAgents(page, project.slug, token);
	const captain = agents.find((a) => a.slug === 'captain') ?? agents[0];

	const taskRes = await page.request.post(`/api/projects/${project.slug}/tasks`, {
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
	await waitForRunWithTrigger(
		page,
		project.slug,
		captain.id,
		token,
		(r) => r.trigger_source !== null,
	);

	// The default view is All, so no filter is needed to reach the row: a run in
	// this environment has no real model provider to reach and ends `failed`.
	// What this test is about is the trigger-reason summary on a row, not which
	// rows a given view shows.
	await page.goto(`/projects/${project.slug}/agents/${captain.id}/executions`);

	const firstRow = page.locator('a[href*="/executions/"]').first();
	await expect(firstRow).toBeVisible({ timeout: 15000 });
	// Any of the rendered trigger sources is acceptable here — assignment
	// fires synchronously on task creation, but chain-after-completion
	// recovery timers can land in the top row too once Captain's flow finishes.
	await expect(firstRow).toContainText(
		/Assigned to|Mentioned by|Scheduled heartbeat|Manually started|Recovery timer|Automation/,
	);
	expect((task as { identifier: string }).identifier).toBeTruthy();
});
