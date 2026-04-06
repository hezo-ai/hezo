import { expect, test } from '@playwright/test';
import { authenticate, getToken } from './helpers';

test('can create an issue', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);
	await page.goto('/companies/new');

	await expect(page.getByText('Choose a template')).toBeVisible({ timeout: 5000 });
	await page.getByRole('button', { name: 'Continue' }).click();

	await page.getByLabel('Name').fill('Issue Test Corp');
	await page.getByRole('button', { name: 'Create' }).click();
	await expect(page.getByRole('link', { name: 'Issues' })).toBeVisible({ timeout: 10000 });

	// Create a project first
	await page.getByRole('link', { name: 'Projects' }).click();
	await page
		.getByRole('button', { name: 'New Project' })
		.filter({ hasText: 'New project' })
		.click();
	await page.getByLabel('Name').fill('Test Project');
	await page.getByRole('button', { name: 'Create' }).click();
	await expect(page.getByText('Test Project')).toBeVisible({ timeout: 5000 });

	// Create issue
	await page.getByRole('link', { name: 'Issues', exact: true }).click();
	await expect(page.getByRole('button', { name: 'New Issue' }).first()).toBeVisible({
		timeout: 10000,
	});
	await page.getByRole('button', { name: 'New Issue' }).first().click();
	await page.getByLabel('Title').fill('Test Issue');
	await page
		.locator('select')
		.filter({ hasText: 'Select project' })
		.selectOption({ label: 'Test Project' });
	await page.getByRole('button', { name: 'Create' }).click();

	await expect(page.getByText('Test Issue')).toBeVisible({ timeout: 10000 });
});

test('issue detail shows execution lock banner when locked', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const token = await getToken(page);
	const headers = { Authorization: `Bearer ${token}` };

	// Create company with agents (need agent for lock)
	const typesRes = await page.request.get('/api/company-types', { headers });
	const types = (await typesRes.json()).data as { id: string; name: string }[];
	const typeId = types.find((t) => t.name === 'Startup')?.id;

	const companyRes = await page.request.post('/api/companies', {
		headers,
		data: {
			name: `Lock Test ${Date.now()}`,
			issue_prefix: `LK${Date.now().toString().slice(-4)}`,
			template_id: typeId,
		},
	});
	const company = (await companyRes.json()).data;

	const projectRes = await page.request.post(`/api/companies/${company.id}/projects`, {
		headers,
		data: { name: 'Lock Project' },
	});
	const project = (await projectRes.json()).data;

	const issueRes = await page.request.post(`/api/companies/${company.id}/issues`, {
		headers,
		data: { project_id: project.id, title: 'Locked Issue' },
	});
	const issue = (await issueRes.json()).data;

	// Get an agent to lock the issue
	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, { headers });
	expect(agentsRes.ok()).toBeTruthy();
	const agents = (await agentsRes.json()).data;
	expect(agents.length).toBeGreaterThan(0);
	const agent = agents[0];

	// Acquire the execution lock
	const lockRes = await page.request.post(`/api/companies/${company.id}/issues/${issue.id}/lock`, {
		headers,
		data: { member_id: agent.id },
	});
	expect(lockRes.ok()).toBeTruthy();

	// Navigate to the issue detail page and wait for the lock query to resolve
	const [, lockApiRes] = await Promise.all([
		page.goto(`/companies/${company.id}/issues/${issue.id}`),
		page.waitForResponse(
			(res) => res.url().includes(`/issues/${issue.id}/lock`) && res.request().method() === 'GET',
		),
	]);
	expect(lockApiRes.ok()).toBeTruthy();

	// Verify the lock banner is visible showing who is working
	await expect(page.getByText('is working on this issue')).toBeVisible({ timeout: 10000 });
});

test('can edit issue rules and progress summary', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const token = await getToken(page);
	const headers = { Authorization: `Bearer ${token}` };

	const companyRes = await page.request.post('/api/companies', {
		headers,
		data: {
			name: `Rules Test ${Date.now()}`,
			issue_prefix: `RT${Date.now().toString().slice(-4)}`,
		},
	});
	const company = (await companyRes.json()).data;

	const projectRes = await page.request.post(`/api/companies/${company.id}/projects`, {
		headers,
		data: { name: 'Rules Project' },
	});
	const project = (await projectRes.json()).data;

	const issueRes = await page.request.post(`/api/companies/${company.id}/issues`, {
		headers,
		data: { project_id: project.id, title: 'Rules Test Issue' },
	});
	const issue = (await issueRes.json()).data;

	await page.goto(`/companies/${company.id}/issues/${issue.id}`);
	await expect(page.getByText('Rules Test Issue')).toBeVisible({ timeout: 10000 });

	// Edit rules
	const rulesSection = page.getByText('Rules', { exact: true }).locator('..').locator('..');
	await rulesSection.getByText('Edit').click();
	await rulesSection.locator('textarea').fill('Consult architect before changes');
	await rulesSection.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByText('Consult architect before changes')).toBeVisible({ timeout: 5000 });

	// Edit progress summary
	const summarySection = page
		.getByText('Progress Summary', { exact: true })
		.locator('..')
		.locator('..');
	await summarySection.getByText('Edit').click();
	await summarySection.locator('textarea').fill('Implementation started');
	await summarySection.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByText('Implementation started')).toBeVisible({ timeout: 5000 });

	// Verify persistence after reload
	await page.reload();
	await expect(page.getByText('Consult architect before changes')).toBeVisible({ timeout: 10000 });
	await expect(page.getByText('Implementation started')).toBeVisible({ timeout: 10000 });
});
