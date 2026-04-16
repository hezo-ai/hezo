import { expect, type Page, test } from '@playwright/test';
import { authenticate, TEST_MASTER_KEY } from './helpers';

async function getToken(page: Page): Promise<string> {
	const tokenRes = await page.request.post('/api/auth/token', {
		data: { master_key: TEST_MASTER_KEY },
	});
	const json = await tokenRes.json();
	return json.data?.token ?? json.token;
}

async function createCompanyWithIssue(page: Page) {
	const token = await getToken(page);
	const headers = { Authorization: `Bearer ${token}` };

	const companyRes = await page.request.post('/api/companies', {
		headers,
		data: { name: `Chat Test ${Date.now()}`, issue_prefix: `CT${Date.now().toString().slice(-4)}` },
	});
	const company = (await companyRes.json()).data;

	const projectRes = await page.request.post(`/api/companies/${company.id}/projects`, {
		headers,
		data: { name: 'Chat Project' },
	});
	const project = (await projectRes.json()).data;

	const agentRes = await page.request.post(`/api/companies/${company.id}/agents`, {
		headers,
		data: { title: 'Chat Agent' },
	});
	const agent = (await agentRes.json()).data;

	const issueRes = await page.request.post(`/api/companies/${company.id}/issues`, {
		headers,
		data: { project_id: project.id, title: 'Chat Test Issue', assignee_id: agent.id },
	});
	const issue = (await issueRes.json()).data;

	return { company, project, issue };
}

test('live chat tab renders and sends messages', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company, issue } = await createCompanyWithIssue(page);

	await page.goto(`/companies/${company.id}/issues/${issue.id}`);

	// Verify issue title loads
	await expect(page.getByText('Chat Test Issue')).toBeVisible({ timeout: 10000 });

	// Click Live Chat tab
	await page.getByText('Live Chat').click();

	// Verify the chat panel is visible with the empty state
	await expect(page.getByText('No messages yet')).toBeVisible({ timeout: 5000 });

	// Type and send a message
	await page.getByPlaceholder('Message').fill('Hello from e2e test');
	await page
		.getByRole('button', { name: /send/i })
		.or(page.locator('button[type="submit"]'))
		.click();

	// Verify message appears in chat
	await expect(page.getByText('Hello from e2e test')).toBeVisible({ timeout: 5000 });
});
