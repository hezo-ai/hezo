import { expect, test } from '@playwright/test';
import { authenticate, createCompanyWithAgents, waitForPageLoad } from './helpers';

test.describe('Project CRUD', () => {
	test('creates a project via dialog', async ({ page }) => {
		await authenticate(page);
		const { company } = await createCompanyWithAgents(page);

		await page.goto(`/companies/${company.slug}/projects`);
		await waitForPageLoad(page);

		// Click "New project" button
		await page.getByRole('button', { name: 'New project' }).click();

		// Fill in the dialog
		await page.getByLabel('Name').fill('Operations');
		await page.getByLabel('Goal').fill('Handle all operational tasks');

		// Submit
		await page.getByRole('button', { name: 'Create' }).click();

		// Verify project appears in the list
		await expect(page.getByText('Operations')).toBeVisible({ timeout: 5000 });
		await expect(page.getByText('Handle all operational tasks')).toBeVisible();
	});

	test('project list shows empty state', async ({ page }) => {
		await authenticate(page);
		const { company } = await createCompanyWithAgents(page);

		await page.goto(`/companies/${company.slug}/projects`);
		await waitForPageLoad(page);

		await expect(page.getByText('No projects yet')).toBeVisible({ timeout: 5000 });
	});

	test('project list shows issue and repo counts', async ({ page }) => {
		await authenticate(page);
		const { company, token } = await createCompanyWithAgents(page);
		const headers = { Authorization: `Bearer ${token}` };

		// Create a project via API
		const projRes = await page.request.post(`/api/companies/${company.id}/projects`, {
			headers,
			data: { name: 'Count Test', goal: 'Testing counts' },
		});
		const project = ((await projRes.json()) as any).data;

		await page.goto(`/companies/${company.slug}/projects`);
		await waitForPageLoad(page);

		// Verify the project card shows counts
		await expect(page.getByText('Count Test')).toBeVisible({ timeout: 5000 });
		await expect(page.getByText('0 issues')).toBeVisible();
		await expect(page.getByText('0 repos')).toBeVisible();
	});

	test('project card links to project detail', async ({ page }) => {
		await authenticate(page);
		const { company, token } = await createCompanyWithAgents(page);
		const headers = { Authorization: `Bearer ${token}` };

		const projRes = await page.request.post(`/api/companies/${company.id}/projects`, {
			headers,
			data: { name: 'Linkable Project' },
		});
		const project = ((await projRes.json()) as any).data;

		await page.goto(`/companies/${company.slug}/projects`);
		await waitForPageLoad(page);

		// Click on the project card
		await page.getByText('Linkable Project').click();

		// Should navigate to project detail page
		await expect(page).toHaveURL(
			new RegExp(`/companies/${company.slug}/projects/${project.slug}`),
			{ timeout: 5000 },
		);
	});

	test('create button is disabled without name', async ({ page }) => {
		await authenticate(page);
		const { company } = await createCompanyWithAgents(page);

		await page.goto(`/companies/${company.slug}/projects`);
		await waitForPageLoad(page);

		await page.getByRole('button', { name: 'New project' }).click();

		// Create button should be disabled when name is empty
		const createBtn = page.getByRole('button', { name: 'Create' });
		await expect(createBtn).toBeDisabled();

		// Fill name — now it should be enabled
		await page.getByLabel('Name').fill('My Project');
		await expect(createBtn).toBeEnabled();
	});
});
