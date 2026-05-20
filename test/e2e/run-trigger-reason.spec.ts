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

interface RunListItem {
	id: string;
	status: string;
	trigger_source: string | null;
	trigger_actor_slug: string | null;
	trigger_comment_id: string | null;
	trigger_comment_issue_identifier: string | null;
}

async function waitForRunWithTrigger(
	page: Page,
	companyId: string,
	agentId: string,
	token: string,
	predicate: (run: RunListItem) => boolean,
	timeoutMs = 120_000,
): Promise<RunListItem> {
	const headers = { Authorization: `Bearer ${token}` };
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const res = await page.request.get(
			`/api/companies/${companyId}/agents/${agentId}/heartbeat-runs`,
			{ headers },
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
	const { company, token } = await createCompanyWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, { headers });
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const ceo = agents.find((a) => a.slug === 'ceo') ?? agents[0];
	const architect = agents.find((a) => a.slug === 'architect') ?? agents[1];

	const project = await createProjectAndClearPlanning(page, company.id, token, {
		name: 'Trigger Reason Project',
		description: 'Test project.',
	});

	await waitForContainer(page, company.id, project.id, token);

	// Assign to the architect so the issue's auto-assignment wakeup goes to a
	// different agent than the one we plan to wake via mention. That way the
	// architect's mention-driven run is unambiguous to find.
	const issueRes = await page.request.post(`/api/companies/${company.id}/issues`, {
		headers,
		data: {
			project_id: project.id,
			title: 'Trigger reason test',
			description: 'Synthetic test task',
			assignee_id: architect.id,
		},
	});
	const issue = ((await issueRes.json()) as { data: { id: string; identifier: string } }).data;

	await page.request.post(`/api/companies/${company.id}/issues/${issue.id}/comments`, {
		headers,
		data: { content_type: 'text', content: { text: `@${ceo.slug} please weigh in here` } },
	});

	const mentionRun = await waitForRunWithTrigger(
		page,
		company.id,
		ceo.id,
		token,
		(r) =>
			r.trigger_source === 'mention' && r.trigger_comment_issue_identifier === issue.identifier,
	);

	await page.goto(`/companies/${company.slug}/agents/${ceo.id}/executions/${mentionRun.id}`);

	const triggerRow = page.getByTestId('run-trigger-reason');
	await expect(triggerRow).toBeVisible({ timeout: 15000 });
	await expect(triggerRow).toContainText('Triggered by');

	const triggerLink = page.getByTestId('run-trigger-link');
	await expect(triggerLink).toBeVisible();
	// Label varies with whether the mentioner is an agent ("Mentioned by @x in OP-12")
	// or a board user ("Mentioned in a comment"); both are acceptable.
	await expect(triggerLink).toContainText(/Mentioned/);

	const href = await triggerLink.getAttribute('href');
	expect(href?.toLowerCase()).toContain(`/issues/${issue.identifier.toLowerCase()}`);
	expect(href).toContain('#c-');
});

test('run list row shows the trigger reason summary', async ({ page }) => {
	await authenticate(page);
	const { company, token } = await createCompanyWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, { headers });
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const ceo = agents.find((a) => a.slug === 'ceo') ?? agents[0];

	const project = await createProjectAndClearPlanning(page, company.id, token, {
		name: 'Trigger List Project',
		description: 'Test project.',
	});

	await waitForContainer(page, company.id, project.id, token);

	const issueRes = await page.request.post(`/api/companies/${company.id}/issues`, {
		headers,
		data: {
			project_id: project.id,
			title: 'Trigger list test',
			description: 'Synthetic test task',
			assignee_id: ceo.id,
		},
	});
	const issue = ((await issueRes.json()) as { data: { id: string; identifier: string } }).data;

	// Wait for at least one terminal run on the assigned agent so the list page
	// has a row to render.
	await waitForRunWithTrigger(page, company.id, ceo.id, token, (r) => r.trigger_source !== null);

	await page.goto(`/companies/${company.slug}/agents/${ceo.id}/executions`);

	const firstRow = page.locator('a[href*="/executions/"]').first();
	await expect(firstRow).toBeVisible({ timeout: 15000 });
	// Any of the rendered sources should appear; the assignment wakeup
	// is the most reliable since it fires synchronously on issue creation.
	await expect(firstRow).toContainText(
		/Assigned to|Mentioned by|Scheduled heartbeat|Manually started/,
	);
	expect((issue as { identifier: string }).identifier).toBeTruthy();
});
