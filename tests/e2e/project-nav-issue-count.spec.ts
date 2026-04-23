import { expect, test } from '@playwright/test';
import { authenticate, createCompanyWithAgents, waitForPageLoad } from './helpers';

test('project nav shows open-issue count and hides it when everything is closed', async ({
	page,
}) => {
	await authenticate(page);
	const { company, token } = await createCompanyWithAgents(page);
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const agent = ((await agentsRes.json()) as { data: Array<{ id: string }> }).data[0];

	const projectRes = await page.request.post(`/api/companies/${company.id}/projects`, {
		headers,
		data: { name: 'Counter Project', description: 'Test project.' },
	});
	const project = (
		(await projectRes.json()) as {
			data: { id: string; slug: string; planning_issue_id: string };
		}
	).data;

	await page.request.patch(`/api/companies/${company.id}/issues/${project.planning_issue_id}`, {
		headers,
		data: { status: 'closed' },
	});

	const issueRes = await page.request.post(`/api/companies/${company.id}/issues`, {
		headers,
		data: { project_id: project.id, title: 'Countable', assignee_id: agent.id },
	});
	const issue = ((await issueRes.json()) as { data: { id: string; identifier: string } }).data;

	await page.goto(`/companies/${company.slug}/projects/${project.slug}/issues`);
	await waitForPageLoad(page);

	const count = page.getByTestId('project-nav-issue-count');
	await expect(count).toBeVisible({ timeout: 10000 });
	await expect(count).toHaveText('(1)');

	await page.request.patch(`/api/companies/${company.id}/issues/${issue.id}`, {
		headers,
		data: { status: 'closed' },
	});

	await expect(count).toBeHidden({ timeout: 10000 });
});
