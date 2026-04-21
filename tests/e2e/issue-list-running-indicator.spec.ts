import { expect, test } from '@playwright/test';
import { authenticate, createCompanyWithAgents, waitForPageLoad } from './helpers';

test('assignee running dot does not appear for issues with no active run', async ({ page }) => {
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

	await expect(page.getByText('Quiet Issue')).toBeVisible({ timeout: 10000 });
	await expect(page.getByTestId('assignee-running-dot')).toHaveCount(0);
});
