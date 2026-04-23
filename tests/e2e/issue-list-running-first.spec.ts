import { expect, test } from '@playwright/test';
import { authenticate, createCompanyWithAgents, waitForPageLoad } from './helpers';

test('issues with active runs pin to the top regardless of sort order', async ({ page }) => {
	await authenticate(page);
	const { company, token } = await createCompanyWithAgents(page);
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const agent = ((await agentsRes.json()) as { data: Array<{ id: string }> }).data[0];

	const projectRes = await page.request.post(`/api/companies/${company.id}/projects`, {
		headers,
		data: { name: 'Pin Project', description: 'Test project.' },
	});
	const project = ((await projectRes.json()) as { data: { id: string; slug: string } }).data;

	const oldRes = await page.request.post(`/api/companies/${company.id}/issues`, {
		headers,
		data: { project_id: project.id, title: 'Old running ticket', assignee_id: agent.id },
	});
	const oldIssue = ((await oldRes.json()) as { data: { id: string } }).data;

	await page.request.post(`/api/companies/${company.id}/issues`, {
		headers,
		data: { project_id: project.id, title: 'New idle ticket', assignee_id: agent.id },
	});

	await page.route(`**/api/companies/${company.slug}/issues?**`, async (route) => {
		const response = await route.fetch();
		const body = await response.json();
		const data = Array.isArray(body) ? body : body.data;
		const targetIdx = data.findIndex((row: { id: string }) => row.id === oldIssue.id);
		if (targetIdx >= 0) {
			const target = data[targetIdx];
			target.has_active_run = true;
			data.splice(targetIdx, 1);
			data.unshift(target);
		}
		await route.fulfill({
			status: response.status(),
			contentType: 'application/json',
			body: JSON.stringify(body),
		});
	});

	await page.goto(`/companies/${company.slug}/projects/${project.slug}/issues`);
	await waitForPageLoad(page);

	const rows = page.getByRole('row').filter({ hasText: /ticket/ });
	await expect(rows.first()).toContainText('Old running ticket', { timeout: 10000 });
});
