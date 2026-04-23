import { expect, test } from '@playwright/test';
import { authenticate, createCompanyWithAgents } from './helpers';

test('run comment shows created tickets as links to their pages', async ({ page }) => {
	await authenticate(page);
	const { company, token } = await createCompanyWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, { headers });
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const ceo = agents.find((a) => a.slug === 'ceo') ?? agents[0];

	const projectRes = await page.request.post(`/api/companies/${company.id}/projects`, {
		headers,
		data: { name: 'Spawned Tickets Project', description: 'Test project.' },
	});
	const project = ((await projectRes.json()) as { data: { id: string; slug: string } }).data;

	const issueRes = await page.request.post(`/api/companies/${company.id}/issues`, {
		headers,
		data: {
			project_id: project.id,
			title: 'Parent With Spawns',
			assignee_id: ceo.id,
		},
	});
	const issue = ((await issueRes.json()) as { data: { id: string } }).data;

	const runId = '99999999-9999-9999-9999-999999999999';
	const spawnedA = {
		id: '11111111-1111-1111-1111-111111111111',
		identifier: 'SPAWN-900',
		title: 'Refactor auth',
		project_slug: project.slug,
	};
	const spawnedB = {
		id: '22222222-2222-2222-2222-222222222222',
		identifier: 'SPAWN-901',
		title: 'Add tests for X',
		project_slug: project.slug,
	};

	const runComment = {
		id: 'aaaa0000-0000-0000-0000-000000000001',
		issue_id: issue.id,
		content_type: 'run',
		content: { run_id: runId, agent_id: ceo.id, agent_title: 'CEO' },
		chosen_option: null,
		created_at: new Date().toISOString(),
		author_type: 'agent',
		author_name: 'CEO',
		author_member_id: ceo.id,
	};

	await page.route(`**/api/companies/*/issues/*/comments**`, async (route) => {
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
		company_id: company.id,
		issue_id: issue.id,
		issue_identifier: 'PARENT-1',
		issue_title: 'Parent With Spawns',
		project_id: project.id,
		status: 'succeeded',
		started_at: new Date().toISOString(),
		finished_at: new Date().toISOString(),
		exit_code: 0,
		error: null,
		input_tokens: 0,
		output_tokens: 0,
		cost_cents: 0,
		invocation_command: null,
		log_text: 'done',
		working_dir: null,
		created_issues: [spawnedA, spawnedB],
	};

	await page.route(`**/api/companies/*/agents/${ceo.id}/heartbeat-runs/${runId}`, async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ data: runResponse }),
		});
	});

	await page.goto(`/companies/${company.slug}/issues/${issue.id}`);

	const runCommentEl = page.getByTestId('run-comment').first();
	await expect(runCommentEl).toBeVisible({ timeout: 10_000 });

	const createdSection = runCommentEl.getByTestId('run-comment-created-issues');
	await expect(createdSection).toBeVisible({ timeout: 10_000 });
	await expect(createdSection).toContainText('Created tickets');

	const linkA = createdSection.getByRole('link', {
		name: `${spawnedA.identifier} — ${spawnedA.title}`,
	});
	await expect(linkA).toHaveAttribute(
		'href',
		`/companies/${company.slug}/projects/${project.slug}/issues/${spawnedA.identifier.toLowerCase()}`,
	);
	const linkB = createdSection.getByRole('link', {
		name: `${spawnedB.identifier} — ${spawnedB.title}`,
	});
	await expect(linkB).toHaveAttribute(
		'href',
		`/companies/${company.slug}/projects/${project.slug}/issues/${spawnedB.identifier.toLowerCase()}`,
	);
});

test('run comment omits created tickets section when list is empty', async ({ page }) => {
	await authenticate(page);
	const { company, token } = await createCompanyWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, { headers });
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const ceo = agents.find((a) => a.slug === 'ceo') ?? agents[0];

	const projectRes = await page.request.post(`/api/companies/${company.id}/projects`, {
		headers,
		data: { name: 'Empty Project', description: 'Test project.' },
	});
	const project = ((await projectRes.json()) as { data: { id: string } }).data;

	const issueRes = await page.request.post(`/api/companies/${company.id}/issues`, {
		headers,
		data: {
			project_id: project.id,
			title: 'Parent No Spawns',
			assignee_id: ceo.id,
		},
	});
	const issue = ((await issueRes.json()) as { data: { id: string } }).data;

	const runId = '99999999-9999-9999-9999-000000000002';
	const runComment = {
		id: 'aaaa0000-0000-0000-0000-000000000002',
		issue_id: issue.id,
		content_type: 'run',
		content: { run_id: runId, agent_id: ceo.id, agent_title: 'CEO' },
		chosen_option: null,
		created_at: new Date().toISOString(),
		author_type: 'agent',
		author_name: 'CEO',
		author_member_id: ceo.id,
	};

	await page.route(`**/api/companies/*/issues/*/comments**`, async (route) => {
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
		company_id: company.id,
		issue_id: issue.id,
		issue_identifier: 'PARENT-2',
		issue_title: 'Parent No Spawns',
		project_id: project.id,
		status: 'succeeded',
		started_at: new Date().toISOString(),
		finished_at: new Date().toISOString(),
		exit_code: 0,
		error: null,
		input_tokens: 0,
		output_tokens: 0,
		cost_cents: 0,
		invocation_command: null,
		log_text: 'done',
		working_dir: null,
		created_issues: [],
	};

	await page.route(`**/api/companies/*/agents/${ceo.id}/heartbeat-runs/${runId}`, async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ data: runResponse }),
		});
	});

	await page.goto(`/companies/${company.slug}/issues/${issue.id}`);

	const runCommentEl = page.getByTestId('run-comment').first();
	await expect(runCommentEl).toBeVisible({ timeout: 10_000 });
	await expect(runCommentEl.getByTestId('run-comment-created-issues')).toHaveCount(0);
});
