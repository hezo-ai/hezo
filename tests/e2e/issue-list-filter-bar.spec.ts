import { expect, test } from '@playwright/test';
import { authenticate, createCompanyWithAgents, waitForPageLoad } from './helpers';

test('issue filter bar collapses/expands and applies search + sort', async ({ page }) => {
	await authenticate(page);
	const { company, token } = await createCompanyWithAgents(page);
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const agent = ((await agentsRes.json()) as { data: Array<{ id: string }> }).data[0];

	const projectRes = await page.request.post(`/api/companies/${company.id}/projects`, {
		headers,
		data: { name: 'Filter Project', description: 'Test project.' },
	});
	const project = ((await projectRes.json()) as { data: { id: string; slug: string } }).data;

	const titles = ['Authentication bug', 'Payment flow', 'Sign-up form'];
	for (const title of titles) {
		await page.request.post(`/api/companies/${company.id}/issues`, {
			headers,
			data: { project_id: project.id, title, assignee_id: agent.id },
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

	await expect(page.getByText('Payment flow')).toBeVisible({ timeout: 5000 });
	await expect(page.getByText('Authentication bug')).toBeHidden();
	await expect(page.getByText('Sign-up form')).toBeHidden();

	await page.getByTestId('issue-filter-reset').click();
	await expect(searchInput).toHaveValue('');
	await expect(page.getByText('Authentication bug')).toBeVisible();
	await expect(page.getByText('Payment flow')).toBeVisible();
	await expect(page.getByText('Sign-up form')).toBeVisible();

	await page.getByTestId('issue-filter-sort-dir').selectOption('asc');
	const rows = page.getByRole('row');
	await expect(rows.filter({ hasText: 'Authentication bug' })).toBeVisible();
});
