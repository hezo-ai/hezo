import { expect, test } from '@playwright/test';
import { authenticate, createCompanyWithAgents, waitForPageLoad } from './helpers';

test.describe('Project Settings', () => {
	async function createProject(page: import('@playwright/test').Page) {
		const { company, token } = await createCompanyWithAgents(page);
		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

		const projRes = await page.request.post(`/api/companies/${company.id}/projects`, {
			headers,
			data: { name: 'Settings Project', goal: 'Test project settings' },
		});
		const project = ((await projRes.json()) as any).data;

		return { company, project, token, headers };
	}

	test('displays project name and goal', async ({ page }) => {
		await authenticate(page);
		const { company, project } = await createProject(page);

		await page.goto(`/companies/${company.slug}/projects/${project.slug}/settings`);
		await waitForPageLoad(page);

		await expect(page.getByRole('heading', { name: 'Settings Project' })).toBeVisible({
			timeout: 5000,
		});
		await expect(page.getByText('Test project settings').first()).toBeVisible();
	});

	test('can edit project goal', async ({ page }) => {
		await authenticate(page);
		const { company, project } = await createProject(page);

		await page.goto(`/companies/${company.slug}/projects/${project.slug}/settings`);
		await waitForPageLoad(page);

		// Click Edit button
		await page.getByRole('button', { name: 'Edit' }).click();

		// Edit goal only (changing name would change the slug and break the URL)
		const goalInput = page.getByLabel('Goal');
		await goalInput.clear();
		await goalInput.fill('Updated goal');

		// Save
		await page.getByRole('button', { name: 'Save' }).click();

		// Verify updated goal
		await expect(page.getByText('Updated goal').first()).toBeVisible({ timeout: 10000 });
	});

	test('cancel button discards edits', async ({ page }) => {
		await authenticate(page);
		const { company, project } = await createProject(page);

		await page.goto(`/companies/${company.slug}/projects/${project.slug}/settings`);
		await waitForPageLoad(page);

		await page.getByRole('button', { name: 'Edit' }).click();

		const nameInput = page.getByLabel('Name');
		await nameInput.clear();
		await nameInput.fill('Should Not Save');

		// Cancel
		await page.getByRole('button', { name: 'Cancel' }).click();

		// Original name should still be visible
		await expect(page.getByRole('heading', { name: 'Settings Project' })).toBeVisible({
			timeout: 5000,
		});
		await expect(page.getByText('Should Not Save')).toBeHidden();
	});

	test('shows repositories section', async ({ page }) => {
		await authenticate(page);
		const { company, project } = await createProject(page);

		await page.goto(`/companies/${company.slug}/projects/${project.slug}/settings`);
		await waitForPageLoad(page);

		// Repositories section header
		await expect(page.getByRole('heading', { name: 'Repositories' })).toBeVisible({
			timeout: 5000,
		});
		await expect(page.getByText('No repositories yet.')).toBeVisible();
		await expect(page.getByRole('button', { name: 'Add Repo' })).toBeVisible();
	});

	test('can toggle add repo form', async ({ page }) => {
		await authenticate(page);
		const { company, project } = await createProject(page);

		await page.goto(`/companies/${company.slug}/projects/${project.slug}/settings`);
		await waitForPageLoad(page);

		// Click "Add Repo" to show form
		await page.getByRole('button', { name: 'Add Repo' }).click();

		// Form fields should be visible
		await expect(page.getByPlaceholder('Short name')).toBeVisible();
		await expect(page.getByPlaceholder('GitHub URL')).toBeVisible();
	});
});
