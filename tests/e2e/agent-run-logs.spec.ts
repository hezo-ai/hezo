import { expect, type Page, test } from '@playwright/test';
import { authenticate, createCompanyWithAgents, createProjectAndClearPlanning } from './helpers';

async function waitForContainer(page: Page, companyId: string, projectId: string, token: string) {
	const headers = { Authorization: `Bearer ${token}` };
	for (let i = 0; i < 150; i++) {
		const res = await page.request.get(`/api/companies/${companyId}/projects/${projectId}`, {
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
	companyId: string,
	issueId: string,
	token: string,
	target: 'running' | 'succeeded' | 'failed',
	timeoutMs = 90_000,
) {
	const headers = { Authorization: `Bearer ${token}` };
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const res = await page.request.get(`/api/companies/${companyId}/issues/${issueId}/latest-run`, {
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
	const { company, token } = await createCompanyWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, { headers });
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const ceo = agents.find((a) => a.slug === 'ceo') ?? agents[0];

	const project = await createProjectAndClearPlanning(page, company.id, token, {
		name: 'Log Test Project',
		description: 'Test project.',
	});

	await waitForContainer(page, company.id, project.id, token);

	const issueRes = await page.request.post(`/api/companies/${company.id}/issues`, {
		headers,
		data: {
			project_id: project.id,
			title: 'Run Me',
			description: 'Synthetic test task',
			assignee_id: ceo.id,
		},
	});
	const issue = ((await issueRes.json()) as { data: { id: string; identifier: string } }).data;

	await page.request.post(`/api/companies/${company.id}/issues/${issue.id}/comments`, {
		headers,
		data: { content_type: 'text', content: { text: 'Please begin' } },
	});

	const run = await waitForRunStatus(page, company.id, issue.id, token, 'succeeded');

	await page.goto(`/companies/${company.slug}/agents/${ceo.id}/executions/${run.id}`);

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

	const issueLink = page.getByRole('link', { name: new RegExp(issue.identifier, 'i') });
	await expect(issueLink).toBeVisible();
	await issueLink.click();
	await expect(page).toHaveURL(new RegExp(`/issues/${issue.identifier.toLowerCase()}$`));
});

test('issue page renders run as an inline comment with live-styled log', async ({
	page,
	context,
}) => {
	await context.grantPermissions(['clipboard-read', 'clipboard-write']);
	await authenticate(page);
	const { company, token } = await createCompanyWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, { headers });
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const ceo = agents.find((a) => a.slug === 'ceo') ?? agents[0];

	const project = await createProjectAndClearPlanning(page, company.id, token, {
		name: 'Run Comment Project',
		description: 'Test project.',
	});

	await waitForContainer(page, company.id, project.id, token);

	const issueRes = await page.request.post(`/api/companies/${company.id}/issues`, {
		headers,
		data: {
			project_id: project.id,
			title: 'Inline Run',
			description: 'Synthetic test task',
			assignee_id: ceo.id,
		},
	});
	const issue = ((await issueRes.json()) as { data: { id: string; identifier: string } }).data;

	await page.request.post(`/api/companies/${company.id}/issues/${issue.id}/comments`, {
		headers,
		data: { content_type: 'text', content: { text: 'Begin' } },
	});

	const run = await waitForRunStatus(page, company.id, issue.id, token, 'succeeded');

	await page.goto(`/companies/${company.slug}/issues/${issue.id}`);

	const runComment = page.getByTestId('run-comment').first();
	await expect(runComment).toBeVisible({ timeout: 20_000 });

	const runLog = runComment.getByTestId('run-comment-log');
	await expect(runLog).toBeVisible();
	await expect(runLog).toContainText('[synthetic]', { timeout: 20_000 });

	const height = await runLog.evaluate((el) => el.getBoundingClientRect().height);
	expect(height).toBeGreaterThan(150);
	expect(height).toBeLessThan(220);

	await expect(page.getByTestId('issue-run-log-tail')).toHaveCount(0);

	const copyBtn = runComment.getByRole('button', { name: /copy logs to clipboard/i });
	await expect(copyBtn).toBeVisible();
	await copyBtn.click();
	await expect(copyBtn).toContainText(/copied/i, { timeout: 2000 });
	const minifiedClipboard = await page.evaluate(() => navigator.clipboard.readText());
	expect(minifiedClipboard).toContain('[synthetic]');

	const expandBtn = runComment.getByRole('button', { name: /expand log viewer/i });
	await expandBtn.click();
	const fullscreen = page.getByTestId('log-viewer-fullscreen');
	await expect(fullscreen).toBeVisible();
	const fullscreenCopyBtn = fullscreen.getByRole('button', { name: /copy logs to clipboard/i });
	await expect(fullscreenCopyBtn).toBeVisible();
	await fullscreenCopyBtn.click();
	await expect(fullscreenCopyBtn).toContainText(/copied/i, { timeout: 2000 });
	const expandedClipboard = await page.evaluate(() => navigator.clipboard.readText());
	expect(expandedClipboard).toContain('[synthetic]');

	await page.keyboard.press('Escape');
	await expect(fullscreen).toBeHidden();

	const runLink = runComment.getByRole('link', { name: /view full run/i });
	await expect(runLink).toBeVisible();
	await runLink.click();
	await expect(page).toHaveURL(new RegExp(`/executions/${run.id}$`));
});
