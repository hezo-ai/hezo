import { expect, type Locator, type Page, test } from '@playwright/test';
import {
	authenticate,
	createProjectAndClearPlanning,
	createProjectReadyForAgents,
	createTeamWithAgents,
	waitForCaptainIdle,
} from './helpers';

async function waitForRunStatus(
	page: Page,
	teamId: string,
	taskId: string,
	token: string,
	target: 'running' | 'succeeded' | 'failed',
	timeoutMs = 180_000,
) {
	const headers = { Authorization: `Bearer ${token}` };
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const res = await page.request.get(`/api/teams/${teamId}/tasks/${taskId}/latest-run`, {
			headers,
		});
		const body = (await res.json()) as { data: null | { id: string; status: string } };
		if (
			body.data &&
			(body.data.status === target || (target === 'running' && body.data.status === 'succeeded'))
		) {
			return body.data;
		}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`Latest run did not reach status ${target} within ${timeoutMs}ms`);
}

test('run detail page streams synthetic agent logs', async ({ page, context }) => {
	await context.grantPermissions(['clipboard-read', 'clipboard-write']);
	await authenticate(page);
	const { team, token } = await createTeamWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	const agentsRes = await page.request.get(`/api/teams/${team.id}/agents`, { headers });
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const captain = agents.find((a) => a.slug === 'captain') ?? agents[0];

	await waitForCaptainIdle(page, team.id, token);

	const project = await createProjectReadyForAgents(page, team, token, {
		name: 'Log Test Project',
		description: 'Test project.',
	});

	const taskRes = await page.request.post(`/api/teams/${team.id}/tasks`, {
		headers,
		data: {
			project_id: project.id,
			title: 'Run Me',
			description: 'Synthetic test task',
			assignee_id: captain.id,
		},
	});
	const task = ((await taskRes.json()) as { data: { id: string; identifier: string } }).data;

	await page.request.post(`/api/teams/${team.id}/tasks/${task.id}/comments`, {
		headers,
		data: { content_type: 'text', content: { text: 'Please begin' } },
	});

	const run = await waitForRunStatus(page, team.id, task.id, token, 'succeeded');

	await page.goto(`/teams/${team.slug}/agents/${captain.id}/executions/${run.id}`);

	await expect(page.getByRole('heading', { name: /Run \w{8}/i })).toBeVisible({ timeout: 15000 });

	const invocationToggle = page.getByRole('button', { name: /invocation/i });
	await expect(invocationToggle).toBeVisible({ timeout: 15000 });
	const invocationBody = page.getByTestId('run-invocation-body');
	await expect(invocationBody).toBeHidden();

	await invocationToggle.click();
	await expect(invocationBody).toBeVisible({ timeout: 2000 });

	await invocationToggle.click();
	await expect(invocationBody).toBeHidden();

	const logPane = page.getByTestId('run-log');
	await expect(logPane).toContainText('[synthetic] starting agent run', { timeout: 20_000 });
	await expect(logPane).toContainText('[synthetic] task complete', { timeout: 15000 });

	const durationValue = page
		.getByText('Duration', { exact: true })
		.locator('xpath=following-sibling::*[1]');
	await expect(durationValue).toHaveText(/^\d+(d\d+h\d+m|h\d+m|m)?\d*s$/);

	const copyBtn = page.getByRole('button', { name: /copy logs to clipboard/i });
	await expect(copyBtn).toBeVisible();
	await copyBtn.click();

	await expect
		.poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 5000 })
		.toContain('[synthetic] starting agent run');

	const taskLink = page.getByRole('link', {
		name: new RegExp(`^Task: ${task.identifier}`, 'i'),
	});
	await expect(taskLink).toBeVisible();
	await taskLink.click();
	await expect(page).toHaveURL(new RegExp(`/tasks/${task.identifier.toLowerCase()}$`));
});

test('task page renders completed run as a collapsed inline comment with summary', async ({
	page,
}) => {
	await authenticate(page);
	const { team, token } = await createTeamWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	const agentsRes = await page.request.get(`/api/teams/${team.id}/agents`, { headers });
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const captain = agents.find((a) => a.slug === 'captain') ?? agents[0];

	const projectRes = await createProjectAndClearPlanning(page, team.id, token, {
		name: 'Collapsed Run Project',
		description: 'Test project.',
	});
	const project = ((await projectRes.json()) as { data: { id: string; slug: string } }).data;

	const taskRes = await page.request.post(`/api/teams/${team.id}/tasks`, {
		headers,
		data: { project_id: project.id, title: 'Collapsed Run Task', assignee_id: captain.id },
	});
	const task = ((await taskRes.json()) as { data: { id: string } }).data;

	const runId = '88888888-8888-8888-8888-888888888888';
	const startedAt = '2026-05-15T18:11:00Z';
	const finishedAt = '2026-05-15T18:12:17Z';
	const logText = Array.from({ length: 27 }, (_, i) => `[synthetic] line ${i + 1}`).join('\n');

	const runComment = {
		id: 'bbbb0000-0000-0000-0000-000000000001',
		task_id: task.id,
		content_type: 'run',
		content: { run_id: runId, agent_id: captain.id, agent_title: 'Product Lead' },
		chosen_option: null,
		created_at: startedAt,
		author_type: 'agent',
		author_name: 'Product Lead',
		author_member_id: captain.id,
	};

	await page.route('**/api/teams/*/tasks/*/comments**', async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ data: [runComment] }),
		});
	});

	const runResponse = {
		id: runId,
		member_id: captain.id,
		team_id: team.id,
		task_id: task.id,
		task_identifier: null,
		task_title: null,
		project_id: project.id,
		status: 'succeeded',
		started_at: startedAt,
		finished_at: finishedAt,
		exit_code: 0,
		error: null,
		input_tokens: 0,
		output_tokens: 0,
		cost_cents: 0,
		invocation_command: null,
		log_text: logText,
		working_dir: null,
		created_tasks: [],
	};

	await page.route(`**/api/teams/*/agents/${captain.id}/heartbeat-runs/${runId}`, async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ data: runResponse }),
		});
	});

	await page.goto(`/teams/${team.slug}/tasks/${task.id}`);

	const runCommentEl = page.getByTestId('run-comment').first();
	await expect(runCommentEl).toBeVisible({ timeout: 20_000 });

	const summary = runCommentEl.getByTestId('run-comment-summary');
	await expect(summary).toBeVisible({ timeout: 20_000 });
	await expect(summary).toContainText('succeeded');
	await expect(summary.getByTestId('run-comment-line-count')).toHaveText('27 lines');
	await expect(summary.getByTestId('run-comment-duration')).toHaveText('1m17s');

	await expect(runCommentEl.getByTestId('run-comment-log')).toHaveCount(0);
	await expect(runCommentEl.getByRole('button', { name: /copy logs to clipboard/i })).toHaveCount(
		0,
	);
	await expect(runCommentEl.getByRole('link', { name: /view full run/i })).toHaveCount(0);

	const header = runCommentEl.getByTestId('run-comment-header');
	await expect(header).toHaveAttribute('aria-expanded', 'false');
});

async function mockCompletedRun(page: Page, teamId: string, agentId: string, token: string) {
	const headers = { Authorization: `Bearer ${token}` };

	const projectRes = await createProjectAndClearPlanning(page, teamId, token, {
		name: 'Expand Run Project',
		description: 'Test project.',
	});
	const project = ((await projectRes.json()) as { data: { id: string; slug: string } }).data;

	const taskRes = await page.request.post(`/api/teams/${teamId}/tasks`, {
		headers,
		data: { project_id: project.id, title: 'Expandable Run Task', assignee_id: agentId },
	});
	const task = ((await taskRes.json()) as { data: { id: string } }).data;

	const runId = '77777777-7777-7777-7777-777777777777';
	const startedAt = '2026-05-15T18:11:00Z';
	const finishedAt = '2026-05-15T18:12:17Z';
	const logText = Array.from({ length: 27 }, (_, i) => `[synthetic] line ${i + 1}`).join('\n');

	const runComment = {
		id: 'cccc0000-0000-0000-0000-000000000001',
		task_id: task.id,
		content_type: 'run',
		content: { run_id: runId, agent_id: agentId, agent_title: 'Product Lead' },
		chosen_option: null,
		created_at: startedAt,
		author_type: 'agent',
		author_name: 'Product Lead',
		author_member_id: agentId,
	};

	await page.route('**/api/teams/*/tasks/*/comments**', async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ data: [runComment] }),
		});
	});

	await page.route(`**/api/teams/*/agents/${agentId}/heartbeat-runs/${runId}`, async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				data: {
					id: runId,
					member_id: agentId,
					team_id: teamId,
					task_id: task.id,
					task_identifier: null,
					task_title: null,
					project_id: project.id,
					status: 'succeeded',
					started_at: startedAt,
					finished_at: finishedAt,
					exit_code: 0,
					error: null,
					input_tokens: 0,
					output_tokens: 0,
					cost_cents: 0,
					invocation_command: null,
					log_text: logText,
					working_dir: null,
					created_tasks: [],
				},
			}),
		});
	});

	return { task, runId };
}

test('clicking the summary on a completed run expands the inline log', async ({ page }) => {
	await authenticate(page);
	const { team, token } = await createTeamWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	const agentsRes = await page.request.get(`/api/teams/${team.id}/agents`, { headers });
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const captain = agents.find((a) => a.slug === 'captain') ?? agents[0];

	const { task, runId } = await mockCompletedRun(page, team.id, captain.id, token);

	await page.goto(`/teams/${team.slug}/tasks/${task.id}`);

	const runCommentEl = page.getByTestId('run-comment').first();
	await expect(runCommentEl).toBeVisible({ timeout: 20_000 });

	const header = runCommentEl.getByTestId('run-comment-header');
	await expect(header).toHaveAttribute('aria-expanded', 'false');
	await expect(runCommentEl.getByTestId('run-comment-log')).toHaveCount(0);

	await header.click();

	await expect(header).toHaveAttribute('aria-expanded', 'true');
	const log = runCommentEl.getByTestId('run-comment-log');
	await expect(log).toBeVisible();
	await expect(log).toContainText('[synthetic] line 1');
	await expect(log).toContainText('[synthetic] line 27');

	const runLink = runCommentEl.getByRole('link', { name: /view full run/i });
	await expect(runLink).toBeVisible();
	await expect(runLink).toHaveAttribute(
		'href',
		new RegExp(`/teams/${team.slug}/agents/${captain.id}/executions/${runId}$`),
	);

	await header.click();
	await expect(header).toHaveAttribute('aria-expanded', 'false');
	await expect(runCommentEl.getByTestId('run-comment-log')).toHaveCount(0);
});

test('completed run expansion works on mobile viewport', async ({ page }) => {
	await page.setViewportSize({ width: 375, height: 800 });
	await authenticate(page);
	const { team, token } = await createTeamWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	const agentsRes = await page.request.get(`/api/teams/${team.id}/agents`, { headers });
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const captain = agents.find((a) => a.slug === 'captain') ?? agents[0];

	const { task } = await mockCompletedRun(page, team.id, captain.id, token);

	await page.goto(`/teams/${team.slug}/tasks/${task.id}`);

	const runCommentEl = page.getByTestId('run-comment').first();
	await expect(runCommentEl).toBeVisible({ timeout: 20_000 });

	const header = runCommentEl.getByTestId('run-comment-header');
	await header.click();

	const log = runCommentEl.getByTestId('run-comment-log');
	await expect(log).toBeVisible();
	await expect(log).toContainText('[synthetic] line 1');
});

// #1 (real CSS layout): asserts the summary row and its expand chevron share a
// single horizontal line via boundingBox y-centres — happy-dom can't lay out
// the flex row, so this can only be verified in a real browser. Mobile width is
// the forcing function: the full header (title · status · lines · duration ·
// timestamp · chevron) is wider than a 375px row, so a wrapping container would
// drop the chevron to a second line.
test('completed run header stays on one line when the log expands (mobile)', async ({ page }) => {
	await page.setViewportSize({ width: 375, height: 800 });
	await authenticate(page);
	const { team, token } = await createTeamWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	const agentsRes = await page.request.get(`/api/teams/${team.id}/agents`, { headers });
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const captain = agents.find((a) => a.slug === 'captain') ?? agents[0];

	const { task } = await mockCompletedRun(page, team.id, captain.id, token);

	await page.goto(`/teams/${team.slug}/tasks/${task.id}`);

	const runCommentEl = page.getByTestId('run-comment').first();
	await expect(runCommentEl).toBeVisible({ timeout: 20_000 });

	const header = runCommentEl.getByTestId('run-comment-header');
	const summary = header.getByTestId('run-comment-summary');
	await expect(summary).toBeVisible({ timeout: 20_000 });
	// The chevron is the only <svg> in the header (the status dot is a <span>).
	const chevron = header.locator('svg');

	const centerY = async (loc: Locator): Promise<number> => {
		const box = await loc.boundingBox();
		if (!box) throw new Error('element has no bounding box');
		return box.y + box.height / 2;
	};

	// Line height is ~16px (text-xs); a wrapped chevron would sit a full line
	// below the summary, so an 8px tolerance cleanly separates one line from two.
	const collapsedDelta = Math.abs((await centerY(chevron)) - (await centerY(summary)));
	expect(collapsedDelta).toBeLessThan(8);

	// Opening the inline log grows the comment and can introduce a scrollbar that
	// narrows the row — the header must not reflow onto a second line.
	await header.click();
	await expect(runCommentEl.getByTestId('run-comment-log')).toBeVisible();
	const expandedDelta = Math.abs((await centerY(chevron)) - (await centerY(summary)));
	expect(expandedDelta).toBeLessThan(8);
});

// #1 (real CSS layout): the leading inline-event icon must share a vertical
// centre-line with the run summary's "<agent> run" label. The icon sits in a
// 26px slot while the label is a 16px text-xs line, so their centres only line
// up if the header row is also 26px tall — a layout fact happy-dom can't compute
// (boundingBox returns 0). Guards the regression where the icon sat ~5px low.
test('completed run inline icon is vertically centred on the summary label', async ({ page }) => {
	await authenticate(page);
	const { team, token } = await createTeamWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	const agentsRes = await page.request.get(`/api/teams/${team.id}/agents`, { headers });
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const captain = agents.find((a) => a.slug === 'captain') ?? agents[0];

	const { task } = await mockCompletedRun(page, team.id, captain.id, token);

	await page.goto(`/teams/${team.slug}/tasks/${task.id}`);

	const runCommentEl = page.getByTestId('run-comment').first();
	await expect(runCommentEl).toBeVisible({ timeout: 20_000 });
	await expect(runCommentEl.getByTestId('run-comment-summary')).toBeVisible({ timeout: 20_000 });

	const commentItem = page
		.getByTestId('comment-item')
		.filter({ has: page.getByTestId('run-comment') })
		.first();
	const icon = commentItem.getByTestId('inline-event-icon');
	const label = runCommentEl.getByText('Product Lead run', { exact: true });

	const centerY = async (loc: Locator): Promise<number> => {
		const box = await loc.boundingBox();
		if (!box) throw new Error('element has no bounding box');
		return box.y + box.height / 2;
	};

	// Buggy layout left the icon centre ~5px below the label centre; aligned
	// centres sit within a sub-pixel. 2px cleanly separates the two states.
	const delta = Math.abs((await centerY(icon)) - (await centerY(label)));
	expect(delta).toBeLessThan(2);
});

// #1 (real CSS layout): asserts the formatted log body keeps the dark terminal
// surface (#0d1117) even with the app forced into light mode — a computed-style
// check happy-dom can't make. Runs on mobile to satisfy the mobile-layout rule.
test('task-page run log offers the formatted/raw switcher on a dark surface in light mode (mobile)', async ({
	page,
}) => {
	await page.emulateMedia({ colorScheme: 'light' });
	await page.addInitScript(() => localStorage.setItem('theme', 'light'));
	await page.setViewportSize({ width: 375, height: 800 });
	await authenticate(page);
	const { team, token } = await createTeamWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	const agentsRes = await page.request.get(`/api/teams/${team.id}/agents`, { headers });
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const captain = agents.find((a) => a.slug === 'captain') ?? agents[0];

	const { task } = await mockCompletedRun(page, team.id, captain.id, token);

	await page.goto(`/teams/${team.slug}/tasks/${task.id}`);

	const runCommentEl = page.getByTestId('run-comment').first();
	await expect(runCommentEl).toBeVisible({ timeout: 20_000 });
	await runCommentEl.getByTestId('run-comment-header').click();

	const log = runCommentEl.getByTestId('run-comment-log');
	await expect(log).toBeVisible();

	// The formatted/raw switcher is available on task-page run logs, defaulting to
	// formatted.
	const formattedBtn = runCommentEl.getByRole('button', { name: 'Formatted view' });
	const rawBtn = runCommentEl.getByRole('button', { name: 'Raw logs' });
	await expect(formattedBtn).toBeVisible();
	await expect(rawBtn).toBeVisible();
	await expect(formattedBtn).toHaveAttribute('aria-pressed', 'true');

	// In light mode the formatted body still uses the dark terminal surface.
	const formattedBg = await log.evaluate((el) => getComputedStyle(el).backgroundColor);
	expect(formattedBg).toBe('rgb(13, 17, 23)');

	// Raw stays on the same dark surface.
	await rawBtn.click();
	await expect(rawBtn).toHaveAttribute('aria-pressed', 'true');
	const rawBg = await runCommentEl
		.getByTestId('run-comment-log')
		.evaluate((el) => getComputedStyle(el).backgroundColor);
	expect(rawBg).toBe('rgb(13, 17, 23)');
});
