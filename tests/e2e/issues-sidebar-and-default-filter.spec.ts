import { expect, test } from '@playwright/test';
import {
	authenticate,
	createCompanyWithAgents,
	createProjectAndClearPlanning,
	waitForPageLoad,
} from './helpers';

test('sidebar Issues count reflects non-terminal issues and updates live', async ({ page }) => {
	await authenticate(page);
	const { company, token } = await createCompanyWithAgents(page);
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const agent = ((await agentsRes.json()) as { data: Array<{ id: string }> }).data[0];

	const project = await createProjectAndClearPlanning(page, company.id, token, {
		name: 'Count Project',
		description: 'Sidebar count test.',
	});

	const issueIds: string[] = [];
	for (const title of ['Alpha', 'Beta', 'Gamma']) {
		const r = await page.request.post(`/api/companies/${company.id}/issues`, {
			headers,
			data: { project_id: project.id, title, assignee_id: agent.id },
		});
		const created = ((await r.json()) as { data: { id: string } }).data;
		issueIds.push(created.id);
	}

	await page.goto(`/companies/${company.slug}/issues`);
	await waitForPageLoad(page);

	const sidebarIssues = page.getByTestId('sidebar-link-issues');
	await expect(sidebarIssues).toContainText('Issues');
	await expect(sidebarIssues).toContainText('3');

	await page.request.patch(`/api/companies/${company.id}/issues/${issueIds[0]}`, {
		headers,
		data: { status: 'closed' },
	});

	await expect(sidebarIssues).toContainText('2', { timeout: 5000 });
	await expect(sidebarIssues).not.toContainText('3');
});

test('default issue filter hides terminal-status issues', async ({ page }) => {
	await authenticate(page);
	const { company, token } = await createCompanyWithAgents(page);
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const agent = ((await agentsRes.json()) as { data: Array<{ id: string }> }).data[0];

	const project = await createProjectAndClearPlanning(page, company.id, token, {
		name: 'Filter Project',
		description: 'Default filter test.',
	});

	const openRes = await page.request.post(`/api/companies/${company.id}/issues`, {
		headers,
		data: { project_id: project.id, title: 'Active work item', assignee_id: agent.id },
	});
	const closedRes = await page.request.post(`/api/companies/${company.id}/issues`, {
		headers,
		data: { project_id: project.id, title: 'Archived old item', assignee_id: agent.id },
	});
	const closedId = ((await closedRes.json()) as { data: { id: string } }).data.id;
	void openRes;

	await page.request.patch(`/api/companies/${company.id}/issues/${closedId}`, {
		headers,
		data: { status: 'closed' },
	});

	await page.goto(`/companies/${company.slug}/projects/${project.slug}/issues`);
	await waitForPageLoad(page);

	await expect(page.getByText('Active work item')).toBeVisible();
	await expect(page.getByText('Archived old item')).toBeHidden();

	await page.getByTestId('issue-filter-toggle').click();
	await expect(page.getByTestId('issue-filter-panel')).toBeVisible();
	const summary = page.getByTestId('issue-filter-toggle');
	await expect(summary).toContainText('Open issues');
});

test('new issue button sits outside the filter bar and remains clickable', async ({ page }) => {
	await authenticate(page);
	const { company, token } = await createCompanyWithAgents(page);

	const project = await createProjectAndClearPlanning(page, company.id, token, {
		name: 'Button Project',
		description: 'Button placement test.',
	});

	await page.goto(`/companies/${company.slug}/projects/${project.slug}/issues`);
	await waitForPageLoad(page);

	const filterBar = page.getByTestId('issue-filter-bar');
	const newIssue = page.getByTestId('issue-list-new-issue');
	await expect(newIssue).toBeVisible();
	await expect(filterBar.getByTestId('issue-list-new-issue')).toHaveCount(0);

	await newIssue.click();
	await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 });
});

test('mobile viewport opens navigation via hamburger drawer', async ({ page }) => {
	await page.setViewportSize({ width: 375, height: 812 });
	await authenticate(page);
	const { company } = await createCompanyWithAgents(page);

	await page.goto(`/companies/${company.slug}/issues`);
	await waitForPageLoad(page);

	await expect(page.getByTestId('sidebar-link-issues')).toBeHidden();

	const toggle = page.getByTestId('mobile-nav-toggle');
	await expect(toggle).toBeVisible();
	await toggle.click();

	const drawer = page.getByTestId('mobile-nav-drawer');
	await expect(drawer).toBeVisible();
	await expect(drawer.getByTestId('sidebar-link-issues')).toBeVisible();

	await page.getByTestId('mobile-nav-close').click();
	await expect(drawer).toBeHidden();
});
