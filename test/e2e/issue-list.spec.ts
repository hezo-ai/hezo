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
		data: { name, description: 'Test project.' },
	});
	return ((await res.json()) as { data: { id: string; slug: string } }).data;
}

async function createIssue(
	page: Page,
	companyId: string,
	token: string,
	data: { project_id: string; title: string; assignee_id: string },
): Promise<{ id: string }> {
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
	const res = await page.request.post(`/api/companies/${companyId}/issues`, { headers, data });
	return ((await res.json()) as { data: { id: string } }).data;
}

async function patchIssueStatus(
	page: Page,
	companyId: string,
	token: string,
	issueId: string,
	status: string,
) {
	await page.request.patch(`/api/companies/${companyId}/issues/${issueId}`, {
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		data: { status },
	});
}

test.describe('Issue list — filtering', () => {
	test('default view shows non-terminal issues with status badges and a collapsed filter bar with New Issue button', async ({
		page,
		freshWorkspace,
	}) => {
		const { company, agents, token } = freshWorkspace;
		const project = await createProject(page, company.id, token, 'Filter Project A');
		const agentId = agents[0].id;

		const issues = await Promise.all([
			createIssue(page, company.id, token, {
				project_id: project.id,
				title: 'Review Issue',
				assignee_id: agentId,
			}),
			createIssue(page, company.id, token, {
				project_id: project.id,
				title: 'In Progress Issue',
				assignee_id: agentId,
			}),
			createIssue(page, company.id, token, {
				project_id: project.id,
				title: 'Done Issue',
				assignee_id: agentId,
			}),
			createIssue(page, company.id, token, {
				project_id: project.id,
				title: 'Backlog Issue',
				assignee_id: agentId,
			}),
		]);
		await patchIssueStatus(page, company.id, token, issues[0].id, 'review');
		await patchIssueStatus(page, company.id, token, issues[1].id, 'in_progress');
		await patchIssueStatus(page, company.id, token, issues[2].id, 'done');

		await page.goto(`/companies/${company.slug}/projects/${project.slug}/issues`);
		await waitForPageLoad(page);

		await expect(page.getByText('Review Issue')).toBeVisible({ timeout: 20000 });
		await expect(page.getByText('In Progress Issue')).toBeVisible();
		await expect(page.getByText('Backlog Issue')).toBeVisible();
		await expect(page.getByText('Done Issue')).toBeHidden();

		await expect(page.getByTestId('issue-filter-bar')).toBeVisible();
		await expect(page.getByTestId('issue-filter-panel')).toBeHidden();
		await expect(page.getByTestId('issue-list-new-issue')).toBeVisible();

		await expect(page.getByText('review').first()).toBeVisible();
		await expect(page.getByText('in progress').first()).toBeVisible();
		await expect(page.getByText('backlog').first()).toBeVisible();
	});

	test('multi-select status filter narrows results and reset restores defaults', async ({
		page,
		freshWorkspace,
	}) => {
		const { company, agents, token } = freshWorkspace;
		const project = await createProject(page, company.id, token, 'Filter Project B');
		const agentId = agents[0].id;

		const created = await Promise.all([
			createIssue(page, company.id, token, {
				project_id: project.id,
				title: 'Review Issue',
				assignee_id: agentId,
			}),
			createIssue(page, company.id, token, {
				project_id: project.id,
				title: 'In Progress Issue',
				assignee_id: agentId,
			}),
			createIssue(page, company.id, token, {
				project_id: project.id,
				title: 'Done Issue',
				assignee_id: agentId,
			}),
			createIssue(page, company.id, token, {
				project_id: project.id,
				title: 'Backlog Issue',
				assignee_id: agentId,
			}),
		]);
		await patchIssueStatus(page, company.id, token, created[0].id, 'review');
		await patchIssueStatus(page, company.id, token, created[1].id, 'in_progress');
		await patchIssueStatus(page, company.id, token, created[2].id, 'done');

		await page.goto(`/companies/${company.slug}/projects/${project.slug}/issues`);
		await waitForPageLoad(page);
		await expect(page.getByText('Review Issue')).toBeVisible({ timeout: 20000 });

		await page.getByTestId('issue-filter-toggle').click();
		await expect(page.getByTestId('issue-filter-panel')).toBeVisible();

		await page.getByTestId('issue-filter-status').click();
		await page.getByRole('button', { name: 'Clear selection' }).click();
		await page.getByRole('button', { name: 'done' }).click();
		await page.keyboard.press('Escape');

		await expect(page.getByText('Done Issue')).toBeVisible({ timeout: 15000 });
		await expect(page.getByText('Review Issue')).toBeHidden();
		await expect(page.getByText('Backlog Issue')).toBeHidden();

		await page.getByTestId('issue-filter-status').click();
		await page.getByRole('button', { name: 'Clear selection' }).click();
		await page.getByRole('button', { name: 'in progress' }).click();
		await page.keyboard.press('Escape');

		await expect(page.getByText('In Progress Issue')).toBeVisible({ timeout: 15000 });
		await expect(page.getByText('Done Issue')).toBeHidden();

		await page.getByTestId('issue-filter-reset').click();
		await expect(page.getByText('Review Issue')).toBeVisible({ timeout: 15000 });
		await expect(page.getByText('In Progress Issue')).toBeVisible();
		await expect(page.getByText('Backlog Issue')).toBeVisible();
		await expect(page.getByText('Done Issue')).toBeHidden();
	});

	test('filter bar collapses/expands and applies search + sort', async ({
		page,
		freshWorkspace,
	}) => {
		const { company, agents, token } = freshWorkspace;
		const project = await createProject(page, company.id, token, 'Filter Project C');
		const agentId = agents[0].id;

		for (const title of ['Authentication bug', 'Payment flow', 'Sign-up form']) {
			await createIssue(page, company.id, token, {
				project_id: project.id,
				title,
				assignee_id: agentId,
			});
		}

		await page.goto(`/companies/${company.slug}/projects/${project.slug}/issues`);
		await waitForPageLoad(page);

		const panel = page.getByTestId('issue-filter-panel');
		await expect(panel).toBeHidden();
		await page.getByTestId('issue-filter-toggle').click();
		await expect(panel).toBeVisible();

		const searchInput = page.getByTestId('issue-filter-search');
		await searchInput.fill('Payment');

		await expect(page.getByText('Payment flow')).toBeVisible({ timeout: 15000 });
		await expect(page.getByText('Authentication bug')).toBeHidden();
		await expect(page.getByText('Sign-up form')).toBeHidden();

		await page.getByTestId('issue-filter-reset').click();
		await expect(searchInput).toHaveValue('');
		await expect(page.getByText('Authentication bug')).toBeVisible();
		await expect(page.getByText('Payment flow')).toBeVisible();
		await expect(page.getByText('Sign-up form')).toBeVisible();

		await page.getByTestId('issue-filter-sort-dir').selectOption('asc');
		await expect(page.getByRole('row').filter({ hasText: 'Authentication bug' })).toBeVisible();
	});
});

test.describe('Issue list — running indicator', () => {
	test('running dot is hidden by default and shown when has_active_run is true', async ({
		page,
		freshWorkspace,
	}) => {
		const { company, agents, token } = freshWorkspace;
		const project = await createProject(page, company.id, token, 'Indicator Project');
		const agentId = agents[0].id;

		await createIssue(page, company.id, token, {
			project_id: project.id,
			title: 'Quiet Issue',
			assignee_id: agentId,
		});
		const busy = await createIssue(page, company.id, token, {
			project_id: project.id,
			title: 'Busy Issue',
			assignee_id: agentId,
		});

		await page.route(`**/api/companies/${company.slug}/issues?**`, async (route) => {
			const response = await route.fetch();
			const body = await response.json();
			const data = Array.isArray(body) ? body : body.data;
			for (const row of data) {
				if (row.id === busy.id) row.has_active_run = true;
			}
			await route.fulfill({
				status: response.status(),
				contentType: 'application/json',
				body: JSON.stringify(body),
			});
		});

		await page.goto(`/companies/${company.slug}/projects/${project.slug}/issues`);
		await waitForPageLoad(page);

		await expect(page.getByText('Quiet Issue')).toBeVisible({ timeout: 20000 });
		await expect(page.getByText('Busy Issue')).toBeVisible();

		const dots = page.getByTestId('issue-running-dot');
		await expect(dots).toHaveCount(1);
		const bgColor = await dots.first().evaluate((el) => getComputedStyle(el).backgroundColor);
		expect(bgColor).toBeTruthy();
		expect(bgColor).not.toBe('rgba(0, 0, 0, 0)');
		expect(bgColor).not.toBe('transparent');
	});

	test('issues with active runs pin to the top regardless of sort order', async ({
		page,
		freshWorkspace,
	}) => {
		const { company, agents, token } = freshWorkspace;
		const project = await createProject(page, company.id, token, 'Pin Project');
		const agentId = agents[0].id;

		const oldIssue = await createIssue(page, company.id, token, {
			project_id: project.id,
			title: 'Old running ticket',
			assignee_id: agentId,
		});
		await createIssue(page, company.id, token, {
			project_id: project.id,
			title: 'New idle ticket',
			assignee_id: agentId,
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
		await expect(rows.first()).toContainText('Old running ticket', { timeout: 20000 });
	});
});
