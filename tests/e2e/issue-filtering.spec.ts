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
			{ title: 'Open Issue', status: 'open' },
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

	test('issue list shows all issues by default', async ({ page }) => {
		await authenticate(page);
		const { company, project } = await setupIssuesWithStatuses(page);

		await page.goto(`/companies/${company.slug}/projects/${project.slug}/issues`);
		await waitForPageLoad(page);

		// All 4 issues should be visible
		await expect(page.getByText('Open Issue')).toBeVisible({ timeout: 10000 });
		await expect(page.getByText('In Progress Issue')).toBeVisible();
		await expect(page.getByText('Done Issue')).toBeVisible();
		await expect(page.getByText('Backlog Issue')).toBeVisible();
	});

	test('filter pills are visible', async ({ page }) => {
		await authenticate(page);
		const { company, project } = await setupIssuesWithStatuses(page);

		await page.goto(`/companies/${company.slug}/projects/${project.slug}/issues`);
		await waitForPageLoad(page);

		// Filter pills should be present
		await expect(page.getByText('Open Issue')).toBeVisible({ timeout: 10000 });
		await expect(page.getByRole('button', { name: 'All' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Open' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'In progress' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Done' })).toBeVisible();
	});

	test('can filter by "Done" status', async ({ page }) => {
		await authenticate(page);
		const { company, project } = await setupIssuesWithStatuses(page);

		await page.goto(`/companies/${company.slug}/projects/${project.slug}/issues`);
		await waitForPageLoad(page);

		// Wait for issues to load
		await expect(page.getByText('Open Issue')).toBeVisible({ timeout: 10000 });

		// Click "Done" filter
		await page.getByRole('button', { name: 'Done' }).click();

		// Only "Done Issue" should be visible
		await expect(page.getByText('Done Issue')).toBeVisible({ timeout: 5000 });
		await expect(page.getByText('Open Issue')).toBeHidden();
		await expect(page.getByText('Backlog Issue')).toBeHidden();
	});

	test('can filter by "In progress" status', async ({ page }) => {
		await authenticate(page);
		const { company, project } = await setupIssuesWithStatuses(page);

		await page.goto(`/companies/${company.slug}/projects/${project.slug}/issues`);
		await waitForPageLoad(page);

		await expect(page.getByText('Open Issue')).toBeVisible({ timeout: 10000 });

		// Click "In progress" filter
		await page.getByRole('button', { name: 'In progress' }).click();

		await expect(page.getByText('In Progress Issue')).toBeVisible({ timeout: 5000 });
		await expect(page.getByText('Done Issue')).toBeHidden();
	});

	test('clicking "All" resets filter', async ({ page }) => {
		await authenticate(page);
		const { company, project } = await setupIssuesWithStatuses(page);

		await page.goto(`/companies/${company.slug}/projects/${project.slug}/issues`);
		await waitForPageLoad(page);

		await expect(page.getByText('Open Issue')).toBeVisible({ timeout: 10000 });

		// Filter to "Done" first
		await page.getByRole('button', { name: 'Done' }).click();
		await expect(page.getByText('Done Issue')).toBeVisible({ timeout: 5000 });
		await expect(page.getByText('Open Issue')).toBeHidden();

		// Click "All" to reset
		await page.getByRole('button', { name: 'All' }).click();

		// All issues should be visible again
		await expect(page.getByText('Open Issue')).toBeVisible({ timeout: 5000 });
		await expect(page.getByText('Done Issue')).toBeVisible();
	});

	test('issue list shows status badges', async ({ page }) => {
		await authenticate(page);
		const { company, project } = await setupIssuesWithStatuses(page);

		await page.goto(`/companies/${company.slug}/projects/${project.slug}/issues`);
		await waitForPageLoad(page);

		await expect(page.getByText('Open Issue')).toBeVisible({ timeout: 10000 });

		// Status badges should be visible in the table
		await expect(page.getByText('open').first()).toBeVisible();
		await expect(page.getByText('in progress').first()).toBeVisible();
		await expect(page.getByText('done').first()).toBeVisible();
	});
});
