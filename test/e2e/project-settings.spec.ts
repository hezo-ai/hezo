import { expect, test } from '@playwright/test';
import { authenticate, createTeamWithAgents, waitForPageLoad } from './helpers';

test.describe('Project Settings', () => {
	async function createProject(page: import('@playwright/test').Page) {
		const { team, token } = await createTeamWithAgents(page);
		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

		const projRes = await page.request.post(`/api/teams/${team.id}/projects`, {
			headers,
			data: {
				name: 'Settings Project',
				description: 'Test project settings.',
			},
		});
		const project = ((await projRes.json()) as { data: { id: string; slug: string } }).data;

		return { team, project, token, headers };
	}

	test('displays project name and description', async ({ page }) => {
		await authenticate(page);
		const { team, project } = await createProject(page);

		await page.goto(`/teams/${team.slug}/projects/${project.slug}/settings`);
		await waitForPageLoad(page);

		await expect(page.getByTestId('breadcrumb').getByText('Settings Project')).toBeVisible({
			timeout: 15000,
		});
		await expect(page.getByText('Test project settings').first()).toBeVisible();
	});

	test('can edit project description', async ({ page }) => {
		await authenticate(page);
		const { team, project } = await createProject(page);

		await page.goto(`/teams/${team.slug}/projects/${project.slug}/settings`);
		await waitForPageLoad(page);

		await page.getByRole('button', { name: 'Edit' }).click();

		const descInput = page.getByLabel('Description');
		await descInput.clear();
		await descInput.fill('Updated description');

		await page.getByRole('button', { name: 'Save' }).click();

		await expect(page.getByText('Updated description').first()).toBeVisible({ timeout: 20000 });
	});

	test('cancel button discards edits', async ({ page }) => {
		await authenticate(page);
		const { team, project } = await createProject(page);

		await page.goto(`/teams/${team.slug}/projects/${project.slug}/settings`);
		await waitForPageLoad(page);

		await page.getByRole('button', { name: 'Edit' }).click();

		const nameInput = page.getByLabel('Name');
		await nameInput.clear();
		await nameInput.fill('Should Not Save');

		await page.getByRole('button', { name: 'Cancel' }).click();

		await expect(page.getByTestId('breadcrumb').getByText('Settings Project')).toBeVisible({
			timeout: 15000,
		});
		await expect(page.getByText('Should Not Save')).toBeHidden();
	});

	test('State A — no GitHub connection: shows Connect GitHub CTA', async ({ page }) => {
		await authenticate(page);
		const { team, project } = await createProject(page);

		await page.goto(`/teams/${team.slug}/projects/${project.slug}/settings`);
		await waitForPageLoad(page);

		await expect(page.getByRole('heading', { name: 'Repositories' })).toBeVisible({
			timeout: 15000,
		});
		await expect(page.getByTestId('repo-setup-state-a')).toBeVisible();
		await expect(page.getByTestId('repo-setup-connect-github')).toBeVisible();
	});
});
