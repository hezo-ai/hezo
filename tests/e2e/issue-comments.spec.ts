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
		await expect(page.getByText('Comments')).toBeVisible({ timeout: 15000 });
	});

	test('can add a comment to an issue', async ({ page }) => {
		await authenticate(page);
		const { company, issue } = await createProjectAndIssue(page);

		await page.goto(`/companies/${company.slug}/issues/${issue.id}`);
		await waitForPageLoad(page);

		// Type a comment
		const commentInput = page.getByPlaceholder('Add a comment...');
		await expect(commentInput).toBeVisible({ timeout: 20000 });
		await commentInput.fill('This is a test comment');

		// Submit the comment
		await page.getByRole('button', { name: 'Comment', exact: true }).click();

		// Verify comment appears
		await expect(page.getByText('This is a test comment')).toBeVisible({ timeout: 15000 });
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
		await expect(page.getByText('API-created comment')).toBeVisible({ timeout: 15000 });
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
		await expect(page.getByText('First comment')).toBeVisible({ timeout: 15000 });
		await expect(page.getByText('Second comment')).toBeVisible();
	});

	test('renders markdown in comment bodies and shows author label', async ({ page }) => {
		await authenticate(page);
		const { company, issue, headers } = await createProjectAndIssue(page);

		const markdownBody =
			'## Execution Plan\n\nFirst paragraph of the plan.\n\nSecond paragraph after a blank line.\n\n**Objective:** Ship it.\n\n- one\n- two';
		await page.request.post(`/api/companies/${company.id}/issues/${issue.id}/comments`, {
			headers,
			data: { content_type: 'text', content: { text: markdownBody } },
		});

		await page.goto(`/companies/${company.slug}/issues/${issue.id}`);
		await waitForPageLoad(page);

		const body = page.getByTestId('text-comment-body').first();
		await expect(body).toBeVisible({ timeout: 15000 });
		await expect(body.locator('h2')).toHaveText('Execution Plan');
		await expect(body.locator('strong')).toHaveText('Objective:');
		await expect(body.locator('li')).toHaveCount(2);
		await expect(body.locator('p')).toHaveCount(3);

		const author = page.getByTestId('comment-author').first();
		await expect(author).toBeVisible();
		await expect(author).toHaveText('Board');
	});

	test('effort dropdown marks the agent default and omits it from the submit body', async ({
		page,
	}) => {
		await authenticate(page);
		const { company, issue, agent } = await createProjectAndIssue(page);

		const expectedDefault =
			agent.slug === 'ceo'
				? 'Max (ultrathink)'
				: {
						minimal: 'Minimal',
						low: 'Low',
						medium: 'Medium',
						high: 'High',
						max: 'Max (ultrathink)',
					}[agent.default_effort as 'minimal' | 'low' | 'medium' | 'high' | 'max'];

		await page.goto(`/companies/${company.slug}/issues/${issue.id}`);
		await waitForPageLoad(page);

		const select = page.getByLabel('Reasoning effort for the agent run triggered by this comment');
		await expect(select).toBeVisible({ timeout: 20000 });

		const labels = await select.locator('option').allTextContents();
		const withSuffix = labels.filter((l) => l.endsWith(' (default)'));
		expect(withSuffix).toHaveLength(1);
		expect(withSuffix[0]).toBe(`${expectedDefault} (default)`);
		expect(labels).not.toContain('Default');

		const postBodies: Array<Record<string, unknown>> = [];
		page.on('request', (req) => {
			if (
				req.method() === 'POST' &&
				/\/api\/companies\/[^/]+\/issues\/[^/]+\/comments$/.test(req.url())
			) {
				postBodies.push(req.postDataJSON());
			}
		});

		await page.getByPlaceholder('Add a comment...').fill('default-effort test');
		await page.getByRole('button', { name: 'Comment', exact: true }).click();
		await expect(page.getByText('default-effort test')).toBeVisible({ timeout: 15000 });

		expect(postBodies).toHaveLength(1);
		expect(postBodies[0]).not.toHaveProperty('effort');
	});

	test('agent mentions render as bold anchor-colored links to agent page', async ({ page }) => {
		await authenticate(page);
		const { company, issue, headers, agent } = await createProjectAndIssue(page);

		const body = `Hey @${agent.slug} please check this. Also @not-a-real-agent-xyz stays plain.`;
		await page.request.post(`/api/companies/${company.id}/issues/${issue.id}/comments`, {
			headers,
			data: { content_type: 'text', content: { text: body } },
		});

		await page.goto(`/companies/${company.slug}/issues/${issue.id}`);
		await waitForPageLoad(page);

		const comment = page.getByTestId('text-comment-body').first();
		await expect(comment).toBeVisible({ timeout: 15000 });

		const mentionLink = comment.getByTestId('agent-mention-link');
		await expect(mentionLink).toHaveText(`@${agent.slug}`);
		await expect(mentionLink).toHaveAttribute(
			'href',
			`/companies/${company.slug}/agents/${agent.slug}`,
		);
		await expect(mentionLink).toHaveClass(/font-semibold/);
		await expect(mentionLink).toHaveClass(/text-accent-blue-text/);

		await expect(comment).toContainText('@not-a-real-agent-xyz');
		await expect(comment.locator('a', { hasText: '@not-a-real-agent-xyz' })).toHaveCount(0);

		await mentionLink.click();
		await expect(page).toHaveURL(
			new RegExp(`/companies/${company.slug}/agents/${agent.slug}(/|$)`),
		);
	});

	test('wake-assignee checkbox is visible, default-checked, and reflected in submit body', async ({
		page,
	}) => {
		await authenticate(page);
		const { company, issue } = await createProjectAndIssue(page);

		await page.goto(`/companies/${company.slug}/issues/${issue.id}`);
		await waitForPageLoad(page);

		const checkbox = page.getByRole('checkbox', { name: 'Wake assignee on submit' });
		await expect(checkbox).toBeVisible({ timeout: 20000 });
		await expect(checkbox).toBeChecked();

		const postBodies: Array<Record<string, unknown>> = [];
		page.on('request', (req) => {
			if (
				req.method() === 'POST' &&
				/\/api\/companies\/[^/]+\/issues\/[^/]+\/comments$/.test(req.url())
			) {
				postBodies.push(req.postDataJSON());
			}
		});

		const textarea = page.getByPlaceholder('Add a comment...');
		const submit = page.getByRole('button', { name: 'Comment', exact: true });

		await textarea.fill('wake-assignee on');
		await submit.click();
		await expect(page.getByText('wake-assignee on')).toBeVisible({ timeout: 15000 });
		await expect(textarea).toHaveValue('');

		await expect(checkbox).toBeChecked();
		await checkbox.uncheck();
		await expect(checkbox).not.toBeChecked();
		await textarea.fill('wake-assignee off');
		await expect(textarea).toHaveValue('wake-assignee off');
		await submit.click();
		await expect(page.getByText('wake-assignee off')).toBeVisible({ timeout: 15000 });

		expect(postBodies).toHaveLength(2);
		expect(postBodies[0].wake_assignee).toBe(true);
		expect(postBodies[1].wake_assignee).toBe(false);

		await expect(checkbox).toBeChecked();
	});

	test('comment items render as bordered cards with a tinted header', async ({ page }) => {
		await authenticate(page);
		const { company, issue, headers } = await createProjectAndIssue(page);

		await page.request.post(`/api/companies/${company.id}/issues/${issue.id}/comments`, {
			headers,
			data: { content_type: 'text', content: { text: 'A boxed comment.' } },
		});

		await page.goto(`/companies/${company.slug}/issues/${issue.id}`);
		await waitForPageLoad(page);

		const item = page.getByTestId('comment-item').first();
		await expect(item).toBeVisible({ timeout: 15000 });

		const card = item.locator('> div').nth(1);
		await expect(card).toHaveClass(/border/);
		await expect(card).toHaveClass(/rounded-md/);

		const header = card.locator('> div').first();
		await expect(header).toHaveClass(/bg-bg-muted/);
		await expect(header.getByTestId('comment-author')).toBeVisible();
	});
});
