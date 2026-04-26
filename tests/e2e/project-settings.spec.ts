import { expect, test } from '@playwright/test';
import { authenticate, createCompanyWithAgents, waitForPageLoad } from './helpers';

test.describe('Project Settings', () => {
	async function createProject(page: import('@playwright/test').Page) {
		const { company, token } = await createCompanyWithAgents(page);
		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

		const projRes = await page.request.post(`/api/companies/${company.id}/projects`, {
			headers,
			data: {
				name: 'Settings Project',
				description: 'Test project settings.',
			},
		});
		const project = ((await projRes.json()) as any).data;

		return { company, project, token, headers };
	}

	test('displays project name and description', async ({ page }) => {
		await authenticate(page);
		const { company, project } = await createProject(page);

		await page.goto(`/companies/${company.slug}/projects/${project.slug}/settings`);
		await waitForPageLoad(page);

		await expect(page.getByTestId('breadcrumb').getByText('Settings Project')).toBeVisible({
			timeout: 15000,
		});
		await expect(page.getByText('Test project settings').first()).toBeVisible();
	});

	test('can edit project description', async ({ page }) => {
		await authenticate(page);
		const { company, project } = await createProject(page);

		await page.goto(`/companies/${company.slug}/projects/${project.slug}/settings`);
		await waitForPageLoad(page);

		// Click Edit button
		await page.getByRole('button', { name: 'Edit' }).click();

		// Edit description only (changing name would change the slug and break the URL)
		const descInput = page.getByLabel('Description');
		await descInput.clear();
		await descInput.fill('Updated description');

		// Save
		await page.getByRole('button', { name: 'Save' }).click();

		// Verify updated description
		await expect(page.getByText('Updated description').first()).toBeVisible({ timeout: 20000 });
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
		await expect(page.getByTestId('breadcrumb').getByText('Settings Project')).toBeVisible({
			timeout: 15000,
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
			timeout: 15000,
		});
		await expect(page.getByText('No repositories yet.')).toBeVisible();
		await expect(page.getByRole('button', { name: 'Add Repo' })).toBeVisible();
	});

	test('"Add Repo" opens the setup wizard', async ({ page }) => {
		await authenticate(page);
		const { company, project } = await createProject(page);

		await page.goto(`/companies/${company.slug}/projects/${project.slug}/settings`);
		await waitForPageLoad(page);

		await page.getByRole('button', { name: 'Add Repo' }).click();

		await expect(page.getByRole('heading', { name: 'Set up repository' })).toBeVisible({
			timeout: 15000,
		});
	});
});
