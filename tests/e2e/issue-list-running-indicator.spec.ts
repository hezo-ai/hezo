import { expect, test } from '@playwright/test';
import { authenticate, createCompanyWithAgents, waitForPageLoad } from './helpers';

test('issue running dot does not appear when no active run', async ({ page }) => {
	await authenticate(page);
	const { company, token } = await createCompanyWithAgents(page);
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const agent = ((await agentsRes.json()) as { data: Array<{ id: string }> }).data[0];

	const projectRes = await page.request.post(`/api/companies/${company.id}/projects`, {
		headers,
		data: { name: 'Indicator Project', description: 'Test project.' },
	});
	const project = ((await projectRes.json()) as { data: { id: string; slug: string } }).data;

	await page.request.post(`/api/companies/${company.id}/issues`, {
		headers,
		data: { project_id: project.id, title: 'Quiet Issue', assignee_id: agent.id },
	});

	await page.goto(`/companies/${company.slug}/projects/${project.slug}/issues`);
	await waitForPageLoad(page);

	await expect(page.getByText('Quiet Issue')).toBeVisible({ timeout: 20000 });
	await expect(page.getByTestId('issue-running-dot')).toHaveCount(0);
});

test('issue running dot appears when has_active_run is true', async ({ page }) => {
	await authenticate(page);
	const { company, token } = await createCompanyWithAgents(page);
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const agent = ((await agentsRes.json()) as { data: Array<{ id: string }> }).data[0];

	const projectRes = await page.request.post(`/api/companies/${company.id}/projects`, {
		headers,
		data: { name: 'Active Project', description: 'Test project.' },
	});
	const project = ((await projectRes.json()) as { data: { id: string; slug: string } }).data;

	const issueRes = await page.request.post(`/api/companies/${company.id}/issues`, {
		headers,
		data: { project_id: project.id, title: 'Busy Issue', assignee_id: agent.id },
	});
	const issue = ((await issueRes.json()) as { data: { id: string } }).data;

	await page.route(`**/api/companies/${company.slug}/issues?**`, async (route) => {
		const response = await route.fetch();
		const body = await response.json();
		const data = Array.isArray(body) ? body : body.data;
		for (const row of data) {
			if (row.id === issue.id) row.has_active_run = true;
		}
		await route.fulfill({
			status: response.status(),
			contentType: 'application/json',
			body: JSON.stringify(body),
		});
	});

	await page.goto(`/companies/${company.slug}/projects/${project.slug}/issues`);
	await waitForPageLoad(page);

	await expect(page.getByText('Busy Issue')).toBeVisible({ timeout: 20000 });
	const dot = page.getByTestId('issue-running-dot');
	await expect(dot).toHaveCount(1);
	const bgColor = await dot.evaluate((el) => getComputedStyle(el).backgroundColor);
	expect(bgColor).toBeTruthy();
	expect(bgColor).not.toBe('rgba(0, 0, 0, 0)');
	expect(bgColor).not.toBe('transparent');
});
