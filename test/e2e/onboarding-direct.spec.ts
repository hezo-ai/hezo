import { expect, test } from './fixtures';
import {
	authenticate,
	createTeamLight,
	getToken,
	setActiveTeamSlug,
	waitForPageLoad,
} from './helpers';

test.describe('Onboarding direct flow', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test('applies a template and creates a project from the wizard direct path', async ({ page }) => {
		await authenticate(page);
		const token = await getToken(page);
		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

		const typesRes = await page.request.get('/api/team-templates', { headers });
		const types = (await typesRes.json()) as { data: Array<{ id: string; name: string }> };
		const blank = types.data.find((t) => t.name === 'Blank');
		expect(blank).toBeDefined();

		const uid = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
		const teamRes = await page.request.post('/api/teams', {
			headers,
			data: { name: `Onboard Direct E2E ${uid}`, template_id: blank?.id },
		});
		const team = ((await teamRes.json()) as { data: { slug: string; id: string } }).data;

		const directRes = await page.request.post(`/api/teams/${team.slug}/onboarding/direct`, {
			headers,
			data: {
				template_id: blank?.id,
				project_name: 'My First App',
				project_description: 'A test project from the direct flow.',
			},
		});
		expect(directRes.status()).toBe(201);
		const direct = (
			(await directRes.json()) as {
				data: { project_slug: string; planning_task_identifier: string };
			}
		).data;

		await page.goto('/home');
		await waitForPageLoad(page);
		await setActiveTeamSlug(page, team.slug);
		await page.reload();
		await waitForPageLoad(page);

		await expect(page.getByTestId('home-projects-list')).toBeVisible({ timeout: 20_000 });
		await expect(page.getByText('My First App')).toBeVisible({ timeout: 20_000 });

		const projectsRes = await page.request.get(`/api/teams/${team.slug}/projects`, { headers });
		const projects = (await projectsRes.json()) as { data: Array<{ slug: string; name: string }> };
		const created = projects.data.find((p) => p.slug === direct.project_slug);
		expect(created?.name).toBe('My First App');
	});

	test("the wizard navigates straight to Captain's planning task after creation", async ({
		page,
	}) => {
		await authenticate(page);
		const { team } = await createTeamLight(page);
		await page.goto('/home');
		await waitForPageLoad(page);
		await setActiveTeamSlug(page, team.slug);
		await page.reload();
		await waitForPageLoad(page);

		await page
			.getByTestId('choice-direct')
			.getByRole('button', { name: 'Browse templates' })
			.click();
		await expect(page.getByTestId('direct-flow-pick')).toBeVisible({ timeout: 20_000 });
		await page.getByTestId('template-card-Blank').click();
		await expect(page.getByTestId('direct-flow-confirm')).toBeVisible({ timeout: 20_000 });

		const projectName = `Direct UI ${Date.now()}`;
		await page.getByLabel('Project name').fill(projectName);

		await Promise.all([
			page.waitForURL(
				new RegExp(`/teams/${team.slug}/projects/direct-ui-[0-9]+/tasks/[a-z0-9-]+(?:\\?.*)?$`),
				{ timeout: 30_000 },
			),
			page.getByRole('button', { name: /Add these agents and create project/ }).click(),
		]);

		expect(page.url()).toMatch(
			new RegExp(`/teams/${team.slug}/projects/direct-ui-[0-9]+/tasks/[a-z0-9-]+`),
		);
	});

	test('the first-time choice screen no longer exposes a "general help" escape hatch', async ({
		page,
	}) => {
		await authenticate(page);

		await page.goto('/home');
		await waitForPageLoad(page);
		await page.reload();
		await waitForPageLoad(page);

		const choiceRoot = page.getByTestId('onboarding-choice');
		if (!(await choiceRoot.isVisible().catch(() => false))) {
			test.skip(true, 'default team already onboarded by a parallel test');
			return;
		}

		await expect(page.getByTestId('choice-general')).toHaveCount(0);
		await expect(page.getByTestId('choice-chat')).toBeVisible();
		await expect(page.getByTestId('choice-direct')).toBeVisible();
	});
});
