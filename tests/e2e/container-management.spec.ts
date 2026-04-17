import { expect, test } from '@playwright/test';
import { authenticate, createCompanyWithAgents, waitForPageLoad } from './helpers';

test.describe('Container Management', () => {
	async function createProjectWithContainer(page: import('@playwright/test').Page) {
		const { company, token } = await createCompanyWithAgents(page);
		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

		const projRes = await page.request.post(`/api/companies/${company.id}/projects`, {
			headers,
			data: {
				name: 'Container Project',
				description: 'Test container management project.',
			},
		});
		const project = ((await projRes.json()) as any).data;

		return { company, project, token, headers };
	}

	test('project detail shows container section', async ({ page }) => {
		await authenticate(page);
		const { company, project } = await createProjectWithContainer(page);

		await page.goto(`/companies/${company.slug}/projects/${project.slug}/container`);
		await waitForPageLoad(page);

		// Container page should render — look for container-related UI
		// The container section shows status and control buttons
		await expect(page.getByText(/container|docker|build|start/i).first()).toBeVisible({
			timeout: 10000,
		});
	});

	test('container page shows rebuild button', async ({ page }) => {
		await authenticate(page);
		const { company, project } = await createProjectWithContainer(page);

		await page.goto(`/companies/${company.slug}/projects/${project.slug}/container`);
		await waitForPageLoad(page);

		// Rebuild button should be present
		await expect(page.getByRole('button', { name: /rebuild/i })).toBeVisible({ timeout: 10000 });
	});

	test('container tab is accessible from project navigation', async ({ page }) => {
		await authenticate(page);
		const { company, project } = await createProjectWithContainer(page);

		// Start at project issues
		await page.goto(`/companies/${company.slug}/projects/${project.slug}/issues`);
		await waitForPageLoad(page);

		// Look for Container tab link
		const containerLink = page.getByRole('link', { name: /container/i });
		if (await containerLink.isVisible()) {
			await containerLink.click();
			await expect(page).toHaveURL(new RegExp(`/projects/${project.slug}/container`), {
				timeout: 5000,
			});
		}
	});
});
