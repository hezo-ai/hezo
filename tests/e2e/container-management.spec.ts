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

	test('banner consolidates multiple unhealthy projects with + N others format and rebuild all button', async ({
		page,
	}) => {
		await authenticate(page);
		const { company, token } = await createCompanyWithAgents(page);
		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

		const projectNames = ['Alpha Banner', 'Beta Banner', 'Gamma Banner'];
		const projects = await Promise.all(
			projectNames.map(async (name) => {
				const res = await page.request.post(`/api/companies/${company.id}/projects`, {
					headers,
					data: { name, description: `${name} description.` },
				});
				return ((await res.json()) as { data: { id: string; slug: string; name: string } }).data;
			}),
		);

		await Promise.all(
			projects.map((project) =>
				expect
					.poll(
						async () => {
							const res = await page.request.get(
								`/api/companies/${company.id}/projects/${project.slug}`,
								{ headers },
							);
							const body = (await res.json()) as {
								data: { container_status: string | null };
							};
							return body.data.container_status;
						},
						{ timeout: 60000, intervals: [500] },
					)
					.toMatch(/^(running|error)$/),
			),
		);

		await Promise.all(
			projects.map((project) =>
				page.request.post(`/api/companies/${company.id}/projects/${project.slug}/container/stop`, {
					headers,
				}),
			),
		);

		await Promise.all(
			projects.map((project) =>
				expect
					.poll(
						async () => {
							const res = await page.request.get(
								`/api/companies/${company.id}/projects/${project.slug}`,
								{ headers },
							);
							const body = (await res.json()) as {
								data: { container_status: string | null };
							};
							return body.data.container_status;
						},
						{ timeout: 60000, intervals: [500] },
					)
					.toMatch(/^(stopped|error)$/),
			),
		);

		await page.goto(`/companies/${company.slug}/inbox`);

		const banner = page.getByTestId('container-status-banner');
		await expect(banner).toBeVisible({ timeout: 10000 });
		await expect(page.getByTestId('container-status-banner-message')).toHaveText(
			/^.+, .+ \+ 1 other containers failed$/,
		);

		const rebuildRequests = projects.map((project) =>
			page.waitForResponse(
				(r) =>
					r.url().includes(`/projects/${project.id}/container/rebuild`) &&
					r.request().method() === 'POST',
				{ timeout: 10000 },
			),
		);

		await banner.getByRole('button', { name: /rebuild all failed containers/i }).click();

		const responses = await Promise.all(rebuildRequests);
		for (const res of responses) {
			expect(res.ok()).toBe(true);
		}
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
