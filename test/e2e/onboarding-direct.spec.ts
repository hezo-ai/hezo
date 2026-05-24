import { expect, test } from './fixtures';
import { authenticate, getToken, setActiveTeamSlug, waitForPageLoad } from './helpers';

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

	test('clicking "general help" on the home choice navigates to the General project tasks page', async ({
		page,
	}) => {
		await authenticate(page);
		const token = await getToken(page);
		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

		// The home page is pinned to the seeded default team, so the OnboardingChoice
		// only renders when that team has no intake and no project. Other parallel
		// tests may have already onboarded it; in that case skip the UI navigation
		// check since the button cannot appear.
		await page.goto('/home');
		await waitForPageLoad(page);
		await page.reload();
		await waitForPageLoad(page);

		const generalButton = page.getByTestId('choice-general');
		if (!(await generalButton.isVisible().catch(() => false))) {
			test.skip(true, 'default team already onboarded by a parallel test');
			return;
		}

		await generalButton.click();
		await page.waitForURL(/\/teams\/default\/projects\/general\/tasks/, { timeout: 15_000 });
		expect(page.url()).toMatch(/\/teams\/default\/projects\/general\/tasks/);

		const projectsRes = await page.request.get('/api/teams/default/projects', { headers });
		const projects = (await projectsRes.json()) as { data: Array<{ slug: string; name: string }> };
		expect(projects.data.some((p) => p.slug === 'general' && p.name === 'General')).toBe(true);
	});

	test('"general help" creates a Blank-template General project with no planning task', async ({
		page,
	}) => {
		await authenticate(page);
		const token = await getToken(page);
		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

		const typesRes = await page.request.get('/api/team-templates', { headers });
		const types = (await typesRes.json()) as { data: Array<{ id: string; name: string }> };
		const blank = types.data.find((t) => t.name === 'Blank');

		const uid = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
		const teamRes = await page.request.post('/api/teams', {
			headers,
			data: { name: `Onboard General E2E ${uid}`, template_id: blank?.id },
		});
		const team = ((await teamRes.json()) as { data: { slug: string } }).data;

		const generalRes = await page.request.post(`/api/teams/${team.slug}/onboarding/direct`, {
			headers,
			data: {
				template_id: blank?.id,
				project_name: 'General',
				project_description: 'Catch-all for ad-hoc help and one-off tasks.',
				skip_planning_task: true,
			},
		});
		expect(generalRes.status()).toBe(201);
		const general = (
			(await generalRes.json()) as {
				data: { project_id: string; planning_task_id: string | null };
			}
		).data;
		expect(general.planning_task_id).toBeNull();

		const projectsRes = await page.request.get(`/api/teams/${team.slug}/projects`, { headers });
		const projects = (await projectsRes.json()) as { data: Array<{ slug: string; name: string }> };
		expect(projects.data.some((p) => p.slug === 'general' && p.name === 'General')).toBe(true);

		const tasksRes = await page.request.get(
			`/api/teams/${team.slug}/tasks?project_id=${general.project_id}`,
			{ headers },
		);
		const tasks = (await tasksRes.json()) as { data: unknown[] };
		expect(tasks.data).toHaveLength(0);
	});

	test('"general help" provisions a container for the General project so agent wakeups can run', async ({
		page,
	}) => {
		await authenticate(page);
		const token = await getToken(page);
		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

		const typesRes = await page.request.get('/api/team-templates', { headers });
		const types = (await typesRes.json()) as { data: Array<{ id: string; name: string }> };
		const blank = types.data.find((t) => t.name === 'Blank');

		const uid = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
		const teamRes = await page.request.post('/api/teams', {
			headers,
			data: { name: `Onboard General Container E2E ${uid}`, template_id: blank?.id },
		});
		const team = ((await teamRes.json()) as { data: { slug: string } }).data;

		const generalRes = await page.request.post(`/api/teams/${team.slug}/onboarding/direct`, {
			headers,
			data: {
				template_id: blank?.id,
				project_name: 'General',
				project_description: 'Catch-all for ad-hoc help and one-off tasks.',
				skip_planning_task: true,
			},
		});
		expect(generalRes.status()).toBe(201);

		// provisionContainer is fire-and-forget; poll until the General project's
		// container_status flips out of null. Without this, agent wakeups for tasks
		// in the project would be silently marked Failed by activateAgent.
		await expect
			.poll(
				async () => {
					const res = await page.request.get(`/api/teams/${team.slug}/projects`, { headers });
					const json = (await res.json()) as {
						data: Array<{ slug: string; container_status: string | null }>;
					};
					return json.data.find((p) => p.slug === 'general')?.container_status ?? null;
				},
				{ timeout: 30_000, intervals: [500, 1000, 2000] },
			)
			.not.toBeNull();
	});
});
