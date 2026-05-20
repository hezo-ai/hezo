import { expect, type Page, test } from '@playwright/test';
import { authenticate, createProjectAndClearPlanning, createTeamWithAgents } from './helpers';

async function waitForContainer(page: Page, teamId: string, projectId: string, token: string) {
	const headers = { Authorization: `Bearer ${token}` };
	for (let i = 0; i < 150; i++) {
		const res = await page.request.get(`/api/teams/${teamId}/projects/${projectId}`, {
			headers,
		});
		const body = (await res.json()) as { data: { container_status?: string } };
		if (body.data?.container_status === 'running') return;
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error('Container did not reach running state within 15s');
}

async function waitForRunStatus(
	page: Page,
	teamId: string,
	issueId: string,
	token: string,
	target: 'running' | 'succeeded' | 'failed',
	timeoutMs = 90_000,
) {
	const headers = { Authorization: `Bearer ${token}` };
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const res = await page.request.get(`/api/teams/${teamId}/issues/${issueId}/latest-run`, {
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
	const ceo = agents.find((a) => a.slug === 'ceo') ?? agents[0];

	const project = await createProjectAndClearPlanning(page, team.id, token, {
		name: 'Log Test Project',
		description: 'Test project.',
	});

	await waitForContainer(page, team.id, project.id, token);

	const issueRes = await page.request.post(`/api/teams/${team.id}/issues`, {
		headers,
		data: {
			project_id: project.id,
			title: 'Run Me',
			description: 'Synthetic test task',
			assignee_id: ceo.id,
		},
	});
	const issue = ((await issueRes.json()) as { data: { id: string; identifier: string } }).data;

	await page.request.post(`/api/teams/${team.id}/issues/${issue.id}/comments`, {
		headers,
		data: { content_type: 'text', content: { text: 'Please begin' } },
	});

	const run = await waitForRunStatus(page, team.id, issue.id, token, 'succeeded');

	await page.goto(`/teams/${team.slug}/agents/${ceo.id}/executions/${run.id}`);

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
	await expect(copyBtn).toContainText(/copied/i, { timeout: 2000 });

	const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
	expect(clipboardText).toContain('[synthetic] starting agent run');

	const issueLink = page.getByRole('link', {
		name: new RegExp(`^Issue: ${issue.identifier}`, 'i'),
	});
	await expect(issueLink).toBeVisible();
	await issueLink.click();
	await expect(page).toHaveURL(new RegExp(`/issues/${issue.identifier.toLowerCase()}$`));
});

test('issue page renders completed run as a collapsed inline comment with summary', async ({
	page,
}) => {
	await authenticate(page);
	const { team, token } = await createTeamWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	const agentsRes = await page.request.get(`/api/teams/${team.id}/agents`, { headers });
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const ceo = agents.find((a) => a.slug === 'ceo') ?? agents[0];

	const projectRes = await page.request.post(`/api/teams/${team.id}/projects`, {
		headers,
		data: { name: 'Collapsed Run Project', description: 'Test project.' },
	});
	const project = ((await projectRes.json()) as { data: { id: string; slug: string } }).data;

	const issueRes = await page.request.post(`/api/teams/${team.id}/issues`, {
		headers,
		data: { project_id: project.id, title: 'Collapsed Run Issue', assignee_id: ceo.id },
	});
	const issue = ((await issueRes.json()) as { data: { id: string } }).data;

	const runId = '88888888-8888-8888-8888-888888888888';
	const startedAt = '2026-05-15T18:11:00Z';
	const finishedAt = '2026-05-15T18:12:17Z';
	const logText = Array.from({ length: 27 }, (_, i) => `[synthetic] line ${i + 1}`).join('\n');

	const runComment = {
		id: 'bbbb0000-0000-0000-0000-000000000001',
		issue_id: issue.id,
		content_type: 'run',
		content: { run_id: runId, agent_id: ceo.id, agent_title: 'Product Lead' },
		chosen_option: null,
		created_at: startedAt,
		author_type: 'agent',
		author_name: 'Product Lead',
		author_member_id: ceo.id,
	};

	await page.route('**/api/teams/*/issues/*/comments**', async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ data: [runComment] }),
		});
	});

	const runResponse = {
		id: runId,
		member_id: ceo.id,
		team_id: team.id,
		issue_id: issue.id,
		issue_identifier: null,
		issue_title: null,
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
		created_issues: [],
	};

	await page.route(`**/api/teams/*/agents/${ceo.id}/heartbeat-runs/${runId}`, async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ data: runResponse }),
		});
	});

	await page.goto(`/teams/${team.slug}/issues/${issue.id}`);

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

	const projectRes = await page.request.post(`/api/teams/${teamId}/projects`, {
		headers,
		data: { name: 'Expand Run Project', description: 'Test project.' },
	});
	const project = ((await projectRes.json()) as { data: { id: string; slug: string } }).data;

	const issueRes = await page.request.post(`/api/teams/${teamId}/issues`, {
		headers,
		data: { project_id: project.id, title: 'Expandable Run Issue', assignee_id: agentId },
	});
	const issue = ((await issueRes.json()) as { data: { id: string } }).data;

	const runId = '77777777-7777-7777-7777-777777777777';
	const startedAt = '2026-05-15T18:11:00Z';
	const finishedAt = '2026-05-15T18:12:17Z';
	const logText = Array.from({ length: 27 }, (_, i) => `[synthetic] line ${i + 1}`).join('\n');

	const runComment = {
		id: 'cccc0000-0000-0000-0000-000000000001',
		issue_id: issue.id,
		content_type: 'run',
		content: { run_id: runId, agent_id: agentId, agent_title: 'Product Lead' },
		chosen_option: null,
		created_at: startedAt,
		author_type: 'agent',
		author_name: 'Product Lead',
		author_member_id: agentId,
	};

	await page.route('**/api/teams/*/issues/*/comments**', async (route) => {
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
					issue_id: issue.id,
					issue_identifier: null,
					issue_title: null,
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
					created_issues: [],
				},
			}),
		});
	});

	return { issue, runId };
}

test('clicking the summary on a completed run expands the inline log', async ({ page }) => {
	await authenticate(page);
	const { team, token } = await createTeamWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	const agentsRes = await page.request.get(`/api/teams/${team.id}/agents`, { headers });
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const ceo = agents.find((a) => a.slug === 'ceo') ?? agents[0];

	const { issue, runId } = await mockCompletedRun(page, team.id, ceo.id, token);

	await page.goto(`/teams/${team.slug}/issues/${issue.id}`);

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
		new RegExp(`/teams/${team.slug}/agents/${ceo.id}/executions/${runId}$`),
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
	const ceo = agents.find((a) => a.slug === 'ceo') ?? agents[0];

	const { issue } = await mockCompletedRun(page, team.id, ceo.id, token);

	await page.goto(`/teams/${team.slug}/issues/${issue.id}`);

	const runCommentEl = page.getByTestId('run-comment').first();
	await expect(runCommentEl).toBeVisible({ timeout: 20_000 });

	const header = runCommentEl.getByTestId('run-comment-header');
	await header.click();

	const log = runCommentEl.getByTestId('run-comment-log');
	await expect(log).toBeVisible();
	await expect(log).toContainText('[synthetic] line 1');
});
