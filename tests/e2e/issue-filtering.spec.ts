import { expect, test } from '@playwright/test';
import { authenticate, createCompanyWithAgents, waitForPageLoad } from './helpers';

test.describe('Issue Filtering', () => {
	async function setupIssuesWithStatuses(page: import('@playwright/test').Page) {
		const { company, token } = await createCompanyWithAgents(page);
		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

		// Create project
		const projRes = await page.request.post(`/api/companies/${company.id}/projects`, {
			headers,
			data: { name: 'Filter Project', description: 'Test project.' },
		});
		const project = ((await projRes.json()) as any).data;

		// Get an agent for assignment
		const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		const agent = ((await agentsRes.json()) as any).data[0];

		// Create issues with different statuses
		const issueData = [
			{ title: 'Review Issue', status: 'review' },
			{ title: 'In Progress Issue', status: 'in_progress' },
			{ title: 'Done Issue', status: 'done' },
			{ title: 'Backlog Issue' }, // default status
		];

		for (const d of issueData) {
			const res = await page.request.post(`/api/companies/${company.id}/issues`, {
				headers,
				data: { project_id: project.id, title: d.title, assignee_id: agent.id },
			});
			const issue = ((await res.json()) as any).data;
			if (d.status) {
				await page.request.patch(`/api/companies/${company.id}/issues/${issue.id}`, {
					headers,
					data: { status: d.status },
				});
			}
		}

		return { company, project, token };
	}

	test('issue list shows non-terminal issues by default', async ({ page }) => {
		await authenticate(page);
		const { company, project } = await setupIssuesWithStatuses(page);

		await page.goto(`/companies/${company.slug}/projects/${project.slug}/issues`);
		await waitForPageLoad(page);

		await expect(page.getByText('Review Issue')).toBeVisible({ timeout: 10000 });
		await expect(page.getByText('In Progress Issue')).toBeVisible();
		await expect(page.getByText('Backlog Issue')).toBeVisible();
		await expect(page.getByText('Done Issue')).toBeHidden();
	});

	test('filter bar renders collapsed by default with a New Issue button', async ({ page }) => {
		await authenticate(page);
		const { company, project } = await setupIssuesWithStatuses(page);

		await page.goto(`/companies/${company.slug}/projects/${project.slug}/issues`);
		await waitForPageLoad(page);

		await expect(page.getByText('Review Issue')).toBeVisible({ timeout: 10000 });
		await expect(page.getByTestId('issue-filter-bar')).toBeVisible();
		await expect(page.getByTestId('issue-filter-panel')).toBeHidden();
		await expect(page.getByTestId('issue-list-new-issue')).toBeVisible();
	});

	test('can filter by "done" status via the expanded filter bar', async ({ page }) => {
		await authenticate(page);
		const { company, project } = await setupIssuesWithStatuses(page);

		await page.goto(`/companies/${company.slug}/projects/${project.slug}/issues`);
		await waitForPageLoad(page);

		await expect(page.getByText('Review Issue')).toBeVisible({ timeout: 10000 });

		await page.getByTestId('issue-filter-toggle').click();
		await expect(page.getByTestId('issue-filter-panel')).toBeVisible();

		await page.getByTestId('issue-filter-status').click();
		await page.getByRole('button', { name: 'Clear selection' }).click();
		await page.getByRole('button', { name: 'done' }).click();
		await page.keyboard.press('Escape');

		await expect(page.getByText('Done Issue')).toBeVisible({ timeout: 15000 });
		await expect(page.getByText('Review Issue')).toBeHidden();
		await expect(page.getByText('Backlog Issue')).toBeHidden();
	});

	test('can filter by "in progress" status via multi-select', async ({ page }) => {
		await authenticate(page);
		const { company, project } = await setupIssuesWithStatuses(page);

		await page.goto(`/companies/${company.slug}/projects/${project.slug}/issues`);
		await waitForPageLoad(page);

		await expect(page.getByText('Review Issue')).toBeVisible({ timeout: 10000 });

		await page.getByTestId('issue-filter-toggle').click();
		await page.getByTestId('issue-filter-status').click();
		await page.getByRole('button', { name: 'Clear selection' }).click();
		await page.getByRole('button', { name: 'in progress' }).click();
		await page.keyboard.press('Escape');

		await expect(page.getByText('In Progress Issue')).toBeVisible({ timeout: 15000 });
		await expect(page.getByText('Review Issue')).toBeHidden();
		await expect(page.getByText('Backlog Issue')).toBeHidden();
	});

	test('reset button restores default non-terminal filter', async ({ page }) => {
		await authenticate(page);
		const { company, project } = await setupIssuesWithStatuses(page);

		await page.goto(`/companies/${company.slug}/projects/${project.slug}/issues`);
		await waitForPageLoad(page);

		await expect(page.getByText('Review Issue')).toBeVisible({ timeout: 10000 });

		await page.getByTestId('issue-filter-toggle').click();
		await page.getByTestId('issue-filter-status').click();
		await page.getByRole('button', { name: 'Clear selection' }).click();
		await page.getByRole('button', { name: 'done' }).click();
		await page.keyboard.press('Escape');
		await expect(page.getByText('Done Issue')).toBeVisible({ timeout: 15000 });
		await expect(page.getByText('Review Issue')).toBeHidden();

		await page.getByTestId('issue-filter-reset').click();

		await expect(page.getByText('Review Issue')).toBeVisible({ timeout: 15000 });
		await expect(page.getByText('In Progress Issue')).toBeVisible();
		await expect(page.getByText('Backlog Issue')).toBeVisible();
		await expect(page.getByText('Done Issue')).toBeHidden();
	});

	test('issue list shows status badges', async ({ page }) => {
		await authenticate(page);
		const { company, project } = await setupIssuesWithStatuses(page);

		await page.goto(`/companies/${company.slug}/projects/${project.slug}/issues`);
		await waitForPageLoad(page);

		await expect(page.getByText('Review Issue')).toBeVisible({ timeout: 10000 });

		await expect(page.getByText('review').first()).toBeVisible();
		await expect(page.getByText('in progress').first()).toBeVisible();
		await expect(page.getByText('backlog').first()).toBeVisible();
	});
});
