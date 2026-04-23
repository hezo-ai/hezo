import { expect, test } from '@playwright/test';
import { authenticate, createCompanyWithAgents, waitForPageLoad } from './helpers';

test('board member can close and re-open an issue via themed modal', async ({ page }) => {
	await authenticate(page);
	const { company, token } = await createCompanyWithAgents(page);
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const agent = ((await agentsRes.json()) as { data: Array<{ id: string }> }).data[0];

	const projectRes = await page.request.post(`/api/companies/${company.id}/projects`, {
		headers,
		data: { name: 'Close Project', description: 'Test project.' },
	});
	const project = ((await projectRes.json()) as { data: { id: string; slug: string } }).data;

	const issueRes = await page.request.post(`/api/companies/${company.id}/issues`, {
		headers,
		data: { project_id: project.id, title: 'Closable Issue', assignee_id: agent.id },
	});
	const issue = ((await issueRes.json()) as { data: { identifier: string } }).data;

	await page.goto(
		`/companies/${company.slug}/projects/${project.slug}/issues/${issue.identifier.toLowerCase()}`,
	);
	await waitForPageLoad(page);

	const closeButton = page.getByTestId('issue-close-button');
	await expect(closeButton).toBeVisible();
	await closeButton.click();

	const dialog = page.getByTestId('confirm-dialog');
	await expect(dialog).toBeVisible();
	await expect(dialog.getByText('Close this issue?')).toBeVisible();

	await page.getByTestId('confirm-dialog-confirm').click();
	await expect(dialog).toBeHidden();

	await expect(page.getByTestId('issue-reopen-button')).toBeVisible({ timeout: 10000 });
	await expect(page.locator('text=closed').first()).toBeVisible();

	await page.getByTestId('issue-reopen-button').click();
	await expect(page.getByTestId('confirm-dialog')).toBeVisible();
	await expect(page.getByText('Re-open this issue?')).toBeVisible();

	await page.getByTestId('confirm-dialog-confirm').click();
	await expect(page.getByTestId('confirm-dialog')).toBeHidden();

	await expect(page.getByTestId('issue-close-button')).toBeVisible({ timeout: 10000 });
});

test('issue detail no longer shows a delete button or status pill row', async ({ page }) => {
	await authenticate(page);
	const { company, token } = await createCompanyWithAgents(page);
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const agent = ((await agentsRes.json()) as { data: Array<{ id: string }> }).data[0];

	const projectRes = await page.request.post(`/api/companies/${company.id}/projects`, {
		headers,
		data: { name: 'No Delete Project', description: 'Test project.' },
	});
	const project = ((await projectRes.json()) as { data: { id: string; slug: string } }).data;

	const issueRes = await page.request.post(`/api/companies/${company.id}/issues`, {
		headers,
		data: { project_id: project.id, title: 'Plain Issue', assignee_id: agent.id },
	});
	const issue = ((await issueRes.json()) as { data: { identifier: string } }).data;

	await page.goto(
		`/companies/${company.slug}/projects/${project.slug}/issues/${issue.identifier.toLowerCase()}`,
	);
	await waitForPageLoad(page);

	await expect(page.getByRole('button', { name: /Delete Issue/i })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'in progress' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'review' })).toHaveCount(0);
	await expect(page.getByTestId('issue-close-button')).toBeVisible();
});
