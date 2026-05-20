import { expect, test } from './fixtures';
import { waitForPageLoad } from './helpers';

type Page = import('@playwright/test').Page;

async function createProject(
	page: Page,
	companyId: string,
	token: string,
	name: string,
): Promise<{ id: string; slug: string }> {
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
	const res = await page.request.post(`/api/companies/${companyId}/projects`, {
		headers,
		data: { name, description: 'Assignee-status test project.' },
	});
	return ((await res.json()) as { data: { id: string; slug: string } }).data;
}

async function createIssue(
	page: Page,
	companyId: string,
	token: string,
	data: { project_id: string; title: string; assignee_id: string },
): Promise<{ id: string; identifier: string }> {
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
	const res = await page.request.post(`/api/companies/${companyId}/issues`, { headers, data });
	return ((await res.json()) as { data: { id: string; identifier: string } }).data;
}

async function forceAgentsActive(page: Page, companySlug: string) {
	await page.route(`**/api/companies/${companySlug}/agents`, async (route) => {
		const response = await route.fetch();
		const body = (await response.json()) as { data: Array<{ runtime_status: string }> };
		for (const agent of body.data) agent.runtime_status = 'active';
		await route.fulfill({
			status: response.status(),
			contentType: 'application/json',
			body: JSON.stringify(body),
		});
	});
}

async function setHasActiveRun(page: Page, companySlug: string, issueId: string, value: boolean) {
	await page.route(`**/api/companies/${companySlug}/issues/*`, async (route) => {
		const response = await route.fetch();
		const body = (await response.json()) as { data?: { id?: string; has_active_run?: boolean } };
		if (body.data && body.data.id === issueId) body.data.has_active_run = value;
		await route.fulfill({
			status: response.status(),
			contentType: 'application/json',
			body: JSON.stringify(body),
		});
	});
}

test.describe('Issue detail — assignee status is ticket-scoped', () => {
	test('idle on this ticket when the assigned agent is running somewhere else', async ({
		page,
		freshWorkspace,
	}) => {
		const { company, agents, token } = freshWorkspace;
		const project = await createProject(page, company.id, token, 'Quiet Project');
		const issue = await createIssue(page, company.id, token, {
			project_id: project.id,
			title: 'Quiet Ticket',
			assignee_id: agents[0].id,
		});

		await forceAgentsActive(page, company.slug);
		await setHasActiveRun(page, company.slug, issue.id, false);

		await page.goto(
			`/companies/${company.slug}/projects/${project.slug}/issues/${issue.identifier.toLowerCase()}`,
		);
		await waitForPageLoad(page);

		const assignee = page.getByTestId('issue-assignee');
		await expect(assignee).toBeVisible({ timeout: 20000 });
		await expect(assignee).toContainText('Idle');
		await expect(assignee).not.toContainText('Running');
		await expect(assignee.getByLabel('Assignee locked: agent is running')).toHaveCount(0);

		await assignee.getByRole('button').first().click();
		await expect(assignee).not.toContainText('Running');
	});

	test('running on this ticket when has_active_run is true', async ({ page, freshWorkspace }) => {
		const { company, agents, token } = freshWorkspace;
		const project = await createProject(page, company.id, token, 'Busy Project');
		const issue = await createIssue(page, company.id, token, {
			project_id: project.id,
			title: 'Busy Ticket',
			assignee_id: agents[0].id,
		});

		await forceAgentsActive(page, company.slug);
		await setHasActiveRun(page, company.slug, issue.id, true);

		await page.goto(
			`/companies/${company.slug}/projects/${project.slug}/issues/${issue.identifier.toLowerCase()}`,
		);
		await waitForPageLoad(page);

		const assignee = page.getByTestId('issue-assignee');
		await expect(assignee).toBeVisible({ timeout: 20000 });
		await expect(assignee).toContainText('Running');
		await expect(assignee.getByLabel('Assignee locked: agent is running')).toBeVisible();
	});

	test('mobile layout: assignee badge follows the same rule', async ({ page, freshWorkspace }) => {
		await page.setViewportSize({ width: 375, height: 720 });

		const { company, agents, token } = freshWorkspace;
		const project = await createProject(page, company.id, token, 'Mobile Quiet');
		const issue = await createIssue(page, company.id, token, {
			project_id: project.id,
			title: 'Mobile Ticket',
			assignee_id: agents[0].id,
		});

		await forceAgentsActive(page, company.slug);
		await setHasActiveRun(page, company.slug, issue.id, false);

		await page.goto(
			`/companies/${company.slug}/projects/${project.slug}/issues/${issue.identifier.toLowerCase()}`,
		);
		await waitForPageLoad(page);

		const assignee = page.getByTestId('issue-assignee');
		await expect(assignee).toBeVisible({ timeout: 20000 });
		await expect(assignee).toContainText('Idle');
		await expect(assignee).not.toContainText('Running');
	});
});
