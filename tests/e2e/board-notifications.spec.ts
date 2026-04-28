import { expect, test } from '@playwright/test';
import { authenticate, createCompanyWithAgents, waitForPageLoad } from './helpers';

interface McpToolResult {
	result?: { content?: Array<{ text?: string }> };
}

async function callRequestBoardApproval(
	page: import('@playwright/test').Page,
	token: string,
	args: { company_id: string; issue_id: string; summary: string },
): Promise<{ comment_id: string; notified: number }> {
	const res = await page.request.post('/mcp', {
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		data: {
			jsonrpc: '2.0',
			method: 'tools/call',
			params: { name: 'request_board_approval', arguments: args },
			id: 1,
		},
	});
	const json = (await res.json()) as McpToolResult;
	const text = json.result?.content?.[0]?.text ?? '{}';
	return JSON.parse(text);
}

test.describe('Board approval notifications', () => {
	test('agent request_board_approval surfaces in board inbox and links back to the comment', async ({
		page,
	}) => {
		await authenticate(page);
		const { company, token } = await createCompanyWithAgents(page);
		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

		const projectRes = await page.request.post(`/api/companies/${company.id}/projects`, {
			headers,
			data: { name: 'Notify E2E', description: 'e2e project' },
		});
		const project = ((await projectRes.json()) as { data: { id: string; slug: string } }).data;

		const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, { headers });
		const agents = ((await agentsRes.json()) as { data: Array<{ id: string }> }).data;

		const issueRes = await page.request.post(`/api/companies/${company.id}/issues`, {
			headers,
			data: {
				project_id: project.id,
				title: 'PRD ready for sign-off',
				assignee_id: agents[0].id,
			},
		});
		const issue = ((await issueRes.json()) as { data: { id: string; identifier: string } }).data;

		const result = await callRequestBoardApproval(page, token, {
			company_id: company.id,
			issue_id: issue.id,
			summary: 'PRD looks ready — please review and approve.',
		});
		expect(result.comment_id).toBeTruthy();
		expect(result.notified).toBeGreaterThanOrEqual(1);

		await page.goto(`/companies/${company.slug}/inbox`);
		await waitForPageLoad(page);

		const card = page.locator('[data-testid="notification-card"]').filter({
			hasText: 'PRD looks ready',
		});
		await expect(card).toBeVisible({ timeout: 15000 });
		await expect(card.getByText('board approval')).toBeVisible();
		await expect(card.getByText(issue.identifier)).toBeVisible();

		await card.click();
		await expect(page).toHaveURL(
			new RegExp(
				`/companies/${company.slug}/projects/${project.slug}/issues/${issue.identifier.toLowerCase()}`,
			),
		);

		const comment = page.locator(`#comment-${result.comment_id}`);
		await expect(comment).toBeVisible({ timeout: 15000 });

		await page.goto(`/companies/${company.slug}/inbox`);
		await waitForPageLoad(page);
		await expect(
			page.locator('[data-testid="notification-card"]').filter({ hasText: 'PRD looks ready' }),
		).toHaveCount(0);
	});
});
