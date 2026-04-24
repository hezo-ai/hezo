import { expect, test } from '@playwright/test';
import { authenticate, createCompanyWithAgents, createProjectAndClearPlanning } from './helpers';

test('bare kb and project-doc references render as tooltip-ed links and navigate to the doc editor', async ({
	page,
}) => {
	await page.goto('/');
	await authenticate(page);

	const { company, token } = await createCompanyWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };
	const json = { ...headers, 'Content-Type': 'application/json' };

	const project = await createProjectAndClearPlanning(page, company.id, token, {
		name: 'Doc Mention Project',
		description: 'Project for doc-mention e2e test.',
	});

	const kbContent = 'Hello onboarding world';
	await page.request.post(`/api/companies/${company.id}/kb-docs`, {
		headers: json,
		data: { title: 'Onboarding Guide', content: kbContent },
	});

	const docContent = 'Runbook step A.\nRunbook step B.';
	await page.request.put(`/api/companies/${company.id}/projects/${project.slug}/docs/runbook.md`, {
		headers: json,
		data: { content: docContent },
	});

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, { headers });
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const ceo = agents.find((a) => a.slug === 'ceo');
	if (!ceo) throw new Error('CEO agent not found');

	const issueRes = await page.request.post(`/api/companies/${company.id}/issues`, {
		headers: json,
		data: {
			project_id: project.id,
			title: 'Doc mention host issue',
			description: `See onboarding-guide and runbook.md for context.`,
			assignee_id: ceo.id,
		},
	});
	const issue = ((await issueRes.json()) as { data: { id: string; identifier: string } }).data;

	await page.goto(
		`/companies/${company.slug}/projects/${project.slug}/issues/${issue.identifier.toLowerCase()}`,
	);
	await expect(page.getByRole('heading', { name: 'Doc mention host issue' })).toBeVisible();

	const kbLink = page.getByTestId('kb-mention-link').first();
	await expect(kbLink).toBeVisible();
	await expect(kbLink).toContainText('onboarding-guide');
	await kbLink.hover();
	await expect(page.getByText('Onboarding Guide', { exact: true }).first()).toBeVisible();

	const docLink = page.getByTestId('doc-mention-link').first();
	await expect(docLink).toBeVisible();
	await expect(docLink).toContainText('runbook.md');

	await kbLink.click();
	await expect(page).toHaveURL(new RegExp(`/companies/${company.slug}/kb\\?slug=onboarding-guide`));
});

test('mention picker opens on @ and inserts the selected handle', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company, token } = await createCompanyWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };
	const json = { ...headers, 'Content-Type': 'application/json' };

	const project = await createProjectAndClearPlanning(page, company.id, token, {
		name: 'Picker Project',
		description: 'Project for mention-picker e2e.',
	});

	await page.request.post(`/api/companies/${company.id}/kb-docs`, {
		headers: json,
		data: { title: 'Picker Doc', content: 'Picker content.' },
	});

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, { headers });
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const ceo = agents.find((a) => a.slug === 'ceo');
	if (!ceo) throw new Error('CEO agent not found');

	const issueRes = await page.request.post(`/api/companies/${company.id}/issues`, {
		headers: json,
		data: { project_id: project.id, title: 'Picker host', assignee_id: ceo.id },
	});
	const issue = ((await issueRes.json()) as { data: { id: string; identifier: string } }).data;

	await page.goto(
		`/companies/${company.slug}/projects/${project.slug}/issues/${issue.identifier.toLowerCase()}`,
	);
	await expect(page.getByRole('heading', { name: 'Picker host' })).toBeVisible();

	const commentBox = page.getByPlaceholder('Add a comment...');
	await commentBox.click();
	await commentBox.type('Reference @picker');

	const picker = page.getByTestId('mention-picker');
	await expect(picker).toBeVisible();

	const option = page.getByTestId('mention-option-kb').first();
	await expect(option).toContainText('Picker Doc');
	await option.click();

	await expect(commentBox).toHaveValue(/(?<!@)picker-doc /);
});

test('rendered markdown autolinks only real entities and leaves look-alikes as text', async ({
	page,
}) => {
	await page.goto('/');
	await authenticate(page);

	const { company, token } = await createCompanyWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };
	const json = { ...headers, 'Content-Type': 'application/json' };

	const project = await createProjectAndClearPlanning(page, company.id, token, {
		name: 'Mixed Mentions',
		description: 'Host project for mixed-mention e2e.',
	});

	await page.request.post(`/api/companies/${company.id}/kb-docs`, {
		headers: json,
		data: { title: 'Coding Standards', slug: 'coding-standards', content: 'Prefer early returns.' },
	});
	await page.request.put(`/api/companies/${company.id}/projects/${project.slug}/docs/spec.md`, {
		headers: json,
		data: { content: 'Spec body.' },
	});

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, { headers });
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const ceo = agents.find((a) => a.slug === 'ceo');
	if (!ceo) throw new Error('CEO agent not found');

	const targetIssueRes = await page.request.post(`/api/companies/${company.id}/issues`, {
		headers: json,
		data: { project_id: project.id, title: 'Target for mixed mentions', assignee_id: ceo.id },
	});
	const targetIssue = (
		(await targetIssueRes.json()) as {
			data: { id: string; identifier: string };
		}
	).data;

	const body = [
		`See ${targetIssue.identifier} and spec.md and coding-standards with @ceo.`,
		`Look-alikes that must stay plain text: UTF-8, ${targetIssue.identifier}x, \`${targetIssue.identifier}\` and \`spec.md\`.`,
	].join('\n\n');

	const hostRes = await page.request.post(`/api/companies/${company.id}/issues`, {
		headers: json,
		data: {
			project_id: project.id,
			title: 'Host for mixed mentions',
			description: body,
			assignee_id: ceo.id,
		},
	});
	const host = ((await hostRes.json()) as { data: { identifier: string } }).data;

	await page.goto(
		`/companies/${company.slug}/projects/${project.slug}/issues/${host.identifier.toLowerCase()}`,
	);
	await expect(page.getByRole('heading', { name: 'Host for mixed mentions' })).toBeVisible();

	await expect(page.getByTestId('issue-mention-link')).toHaveCount(1);
	await expect(page.getByTestId('doc-mention-link')).toHaveCount(1);
	await expect(page.getByTestId('kb-mention-link')).toHaveCount(1);
	await expect(page.getByTestId('agent-mention-link')).toHaveCount(1);
});
