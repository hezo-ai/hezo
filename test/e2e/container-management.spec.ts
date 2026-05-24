import { expect, test } from '@playwright/test';
import { authenticate, createTeamWithAgents, waitForPageLoad } from './helpers';

test.describe('Container Management', () => {
	test('container page renders rebuild button and is reachable from project nav', async ({
		page,
	}) => {
		await authenticate(page);
		const { team, token } = await createTeamWithAgents(page);
		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

		const projRes = await page.request.post(`/api/teams/${team.id}/projects`, {
			headers,
			data: { name: 'Container Project', description: 'Test container management project.' },
		});
		const project = ((await projRes.json()) as { data: { slug: string } }).data;

		await page.goto(`/teams/${team.slug}/projects/${project.slug}/container`);
		await waitForPageLoad(page);

		await expect(page.getByText(/container|docker|build|start/i).first()).toBeVisible({
			timeout: 20000,
		});
		await expect(page.getByRole('button', { name: /rebuild/i })).toBeVisible({ timeout: 20000 });

		await page.goto(`/teams/${team.slug}/projects/${project.slug}/tasks`);
		await waitForPageLoad(page);

		const containerLink = page.getByRole('link', { name: /container/i });
		if (await containerLink.isVisible()) {
			await containerLink.click();
			await expect(page).toHaveURL(new RegExp(`/projects/${project.slug}/container`), {
				timeout: 15000,
			});
		}
	});

	test('container page shows "Waiting for container output…" when status is running but no logs yet (mobile)', async ({
		page,
	}) => {
		await page.setViewportSize({ width: 375, height: 800 });
		await authenticate(page);
		const { team } = await createTeamWithAgents(page);

		const fakeProject = {
			id: '22222222-2222-2222-2222-000000000001',
			slug: 'running-no-logs',
			name: 'Running No Logs',
			team_id: team.id,
			task_prefix: 'RN',
			description: '',
			docker_base_image: 'hezo/agent-base:latest',
			container_id: 'abc123def456',
			container_status: 'running',
			container_error: null,
			container_last_logs: null,
			dev_ports: [],
			repo_count: 0,
			open_task_count: 0,
			created_at: new Date().toISOString(),
		};

		await page.route(`**/api/teams/*/projects/running-no-logs`, async (route) => {
			if (route.request().method() !== 'GET') return route.continue();
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ data: fakeProject }),
			});
		});

		await page.goto(`/teams/${team.slug}/projects/${fakeProject.slug}/container`);
		await waitForPageLoad(page);

		await expect(page.getByText(/^Running$/).first()).toBeVisible({ timeout: 15000 });
		await expect(page.getByText(/Waiting for container output/i)).toBeVisible({ timeout: 15000 });
		await expect(page.getByText(/Container is not running/i)).not.toBeVisible();
	});

	test('banner consolidates multiple unhealthy projects with + N others format and rebuild all button', async ({
		page,
	}) => {
		await authenticate(page);
		const { team } = await createTeamWithAgents(page);

		const fakeProjects = [
			{ id: '11111111-1111-1111-1111-000000000001', slug: 'alpha-banner', name: 'Alpha Banner' },
			{ id: '11111111-1111-1111-1111-000000000002', slug: 'beta-banner', name: 'Beta Banner' },
			{ id: '11111111-1111-1111-1111-000000000003', slug: 'gamma-banner', name: 'Gamma Banner' },
		].map((p) => ({
			...p,
			team_id: team.id,
			task_prefix: 'AB',
			description: '',
			docker_base_image: null,
			container_id: null,
			container_status: 'error',
			container_error: 'simulated build failure',
			container_last_logs: null,
			dev_ports: [],
			repo_count: 0,
			open_task_count: 0,
			created_at: new Date().toISOString(),
		}));

		await page.route(`**/api/teams/*/projects`, async (route) => {
			if (route.request().method() !== 'GET') return route.continue();
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ data: fakeProjects }),
			});
		});

		const rebuildPosts: string[] = [];
		await page.route(`**/projects/*/container/rebuild`, async (route) => {
			if (route.request().method() !== 'POST') return route.continue();
			rebuildPosts.push(route.request().url());
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ data: { ok: true } }),
			});
		});

		await page.goto(`/teams/${team.slug}/inbox`);

		const banner = page.getByTestId('container-status-banner');
		await expect(banner).toBeVisible({ timeout: 20000 });
		await expect(page.getByTestId('container-status-banner-message')).toHaveText(
			/^.+, .+ \+ 1 other containers failed$/,
		);

		await banner.getByRole('button', { name: /rebuild all failed containers/i }).click();

		await expect.poll(() => rebuildPosts.length, { timeout: 10000 }).toBe(fakeProjects.length);
		for (const project of fakeProjects) {
			expect(
				rebuildPosts.some((url) => url.includes(`/projects/${project.id}/container/rebuild`)),
			).toBe(true);
		}
	});
});
