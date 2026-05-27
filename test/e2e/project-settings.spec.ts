import { expect, test } from './fixtures';
import { createProjectAndClearPlanning, uniqueName, waitForPageLoad } from './helpers';

test.describe('Project Settings', () => {
	async function createProject(
		page: import('@playwright/test').Page,
		team: { id: string; slug: string },
		token: string,
	) {
		const projectName = uniqueName('Settings Project');
		const projRes = await createProjectAndClearPlanning(page, team.id, token, {
			name: projectName,
			description: 'Test project settings.',
		});
		const project = ((await projRes.json()) as { data: { id: string; slug: string } }).data;

		return { team, project, projectName, token };
	}

	test('displays project name and description', async ({ sharedPage: page, sharedWorkspace }) => {
		const { team, project, projectName } = await createProject(
			page,
			sharedWorkspace.team,
			sharedWorkspace.token,
		);

		await page.goto(`/teams/${team.slug}/projects/${project.slug}/settings`);
		await waitForPageLoad(page);

		await expect(page.getByTestId('breadcrumb').getByText(projectName)).toBeVisible({
			timeout: 15000,
		});
		await expect(page.getByText('Test project settings').first()).toBeVisible();
	});

	test('can edit project description', async ({ sharedPage: page, sharedWorkspace }) => {
		const { team, project } = await createProject(
			page,
			sharedWorkspace.team,
			sharedWorkspace.token,
		);

		await page.goto(`/teams/${team.slug}/projects/${project.slug}/settings`);
		await waitForPageLoad(page);

		await page.getByRole('button', { name: 'Edit' }).click();

		const descInput = page.getByLabel('Description');
		await descInput.clear();
		await descInput.fill('Updated description');

		await page.getByRole('button', { name: 'Save' }).click();

		await expect(page.getByText('Updated description').first()).toBeVisible({ timeout: 20000 });
	});

	test('cancel button discards edits', async ({ sharedPage: page, sharedWorkspace }) => {
		const { team, project, projectName } = await createProject(
			page,
			sharedWorkspace.team,
			sharedWorkspace.token,
		);

		await page.goto(`/teams/${team.slug}/projects/${project.slug}/settings`);
		await waitForPageLoad(page);

		await page.getByRole('button', { name: 'Edit' }).click();

		const nameInput = page.getByLabel('Name');
		await nameInput.clear();
		await nameInput.fill('Should Not Save');

		await page.getByRole('button', { name: 'Cancel' }).click();

		await expect(page.getByTestId('breadcrumb').getByText(projectName)).toBeVisible({
			timeout: 15000,
		});
		await expect(page.getByText('Should Not Save')).toBeHidden();
	});

	test('State A — no GitHub connection: shows Connect GitHub CTA', async ({
		sharedPage: page,
		sharedWorkspace,
	}) => {
		const { team, project } = await createProject(
			page,
			sharedWorkspace.team,
			sharedWorkspace.token,
		);

		await page.goto(`/teams/${team.slug}/projects/${project.slug}/settings`);
		await waitForPageLoad(page);

		await expect(page.getByRole('heading', { name: 'Repositories' })).toBeVisible({
			timeout: 15000,
		});
		await expect(page.getByTestId('repo-setup-state-a')).toBeVisible();
		await expect(page.getByTestId('repo-setup-connect-github')).toBeVisible();
	});
});
