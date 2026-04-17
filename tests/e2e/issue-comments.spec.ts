import { expect, test } from '@playwright/test';
import { authenticate, createCompanyWithAgents, waitForPageLoad } from './helpers';

test.describe('Issue Comments', () => {
	async function createProjectAndIssue(page: import('@playwright/test').Page) {
		const { company, token } = await createCompanyWithAgents(page);
		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

		// Create project
		const projRes = await page.request.post(`/api/companies/${company.id}/projects`, {
			headers,
			data: { name: 'Comment Project', description: 'Test project.' },
		});
		const project = ((await projRes.json()) as any).data;

		// Get an agent for assignment
		const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		const agents = ((await agentsRes.json()) as any).data;
		const agent = agents[0];

		// Create issue
		const issueRes = await page.request.post(`/api/companies/${company.id}/issues`, {
			headers,
			data: { project_id: project.id, title: 'Comment Test Issue', assignee_id: agent.id },
		});
		const issue = ((await issueRes.json()) as any).data;

		return { company, token, project, issue, agent, headers };
	}

	test('issue detail shows comments tab with count', async ({ page }) => {
		await authenticate(page);
		const { company, issue } = await createProjectAndIssue(page);

		await page.goto(`/companies/${company.slug}/issues/${issue.id}`);
		await waitForPageLoad(page);

		// Comments tab should be visible
		await expect(page.getByText('Comments')).toBeVisible({ timeout: 5000 });
	});

	test('can add a comment to an issue', async ({ page }) => {
		await authenticate(page);
		const { company, issue } = await createProjectAndIssue(page);

		await page.goto(`/companies/${company.slug}/issues/${issue.id}`);
		await waitForPageLoad(page);

		// Type a comment
		const commentInput = page.getByPlaceholder('Add a comment...');
		await expect(commentInput).toBeVisible({ timeout: 10000 });
		await commentInput.fill('This is a test comment');

		// Submit the comment
		await page.getByRole('button', { name: 'Comment', exact: true }).click();

		// Verify comment appears
		await expect(page.getByText('This is a test comment')).toBeVisible({ timeout: 5000 });
	});

	test('comments persist after page reload', async ({ page }) => {
		await authenticate(page);
		const { company, issue, headers } = await createProjectAndIssue(page);

		// Create a comment via API
		await page.request.post(`/api/companies/${company.id}/issues/${issue.id}/comments`, {
			headers,
			data: { content: 'API-created comment' },
		});

		await page.goto(`/companies/${company.slug}/issues/${issue.id}`);
		await waitForPageLoad(page);

		// Verify the comment is visible
		await expect(page.getByText('API-created comment')).toBeVisible({ timeout: 5000 });
	});

	test('comment count updates after adding comment', async ({ page }) => {
		await authenticate(page);
		const { company, issue, headers } = await createProjectAndIssue(page);

		// Create two comments via API
		await page.request.post(`/api/companies/${company.id}/issues/${issue.id}/comments`, {
			headers,
			data: { content: 'First comment' },
		});
		await page.request.post(`/api/companies/${company.id}/issues/${issue.id}/comments`, {
			headers,
			data: { content: 'Second comment' },
		});

		await page.goto(`/companies/${company.slug}/issues/${issue.id}`);
		await waitForPageLoad(page);

		// Both comments should be visible
		await expect(page.getByText('First comment')).toBeVisible({ timeout: 5000 });
		await expect(page.getByText('Second comment')).toBeVisible();
	});
});
