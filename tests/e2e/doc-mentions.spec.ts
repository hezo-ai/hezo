import { expect, test } from '@playwright/test';
import { authenticate, createCompanyWithAgents, createProjectAndClearPlanning } from './helpers';

test('kb and project doc @-mentions render as tooltip-ed links and navigate to the doc editor', async ({
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
			description: `See @kb/onboarding-guide and @doc/runbook.md for context.`,
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
	await expect(kbLink).toContainText('@kb/onboarding-guide');
	await kbLink.hover();
	await expect(page.getByText('Onboarding Guide', { exact: true }).first()).toBeVisible();

	const docLink = page.getByTestId('doc-mention-link').first();
	await expect(docLink).toBeVisible();
	await expect(docLink).toContainText('@doc/runbook.md');

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

	await expect(commentBox).toHaveValue(/@kb\/picker-doc /);
});
