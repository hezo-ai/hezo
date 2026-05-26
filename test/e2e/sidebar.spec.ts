import { expect, test } from './fixtures';
import { createProjectAndClearPlanning, waitForCaptainIdle, waitForPageLoad } from './helpers';

type Page = import('@playwright/test').Page;

async function suppressAiModal(page: Page) {
	await page.route('**/ai-providers/status', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ data: { configured: true } }),
		}),
	);
}

async function createProject(
	page: Page,
	teamId: string,
	token: string,
	name: string,
): Promise<{ id: string; slug: string; name: string }> {
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
	const res = await createProjectAndClearPlanning(page, teamId, token, {
		name,
		description: 'Test project.',
	});
	return ((await res.json()) as { data: { id: string; slug: string; name: string } }).data;
}

test.describe('Sidebar — sections and nav targets', () => {
	test('sidebar shows all top-level sections with the expected nav links', async ({
		page,
		freshWorkspace,
	}) => {
		const { team } = freshWorkspace;
		await suppressAiModal(page);
		await page.goto(`/teams/${team.slug}/tasks`);
		await waitForPageLoad(page);

		const nav = page.locator('nav');
		await expect(nav.getByText('Inbox', { exact: true })).toBeVisible();
		await expect(nav.getByText('Work', { exact: true })).toBeVisible();
		await expect(nav.getByText('Projects', { exact: true })).toBeVisible();
		await expect(nav.getByText('Team', { exact: true })).toBeVisible();
		await expect(nav.getByText('Resources', { exact: true })).toBeVisible();
		await expect(nav.getByRole('link', { name: 'Tasks' })).toBeVisible();
		await expect(nav.getByRole('link', { name: 'Projects' })).toBeVisible();
		await expect(nav.getByRole('link', { name: 'Team' })).toBeVisible();
		await expect(nav.getByText('All agents')).not.toBeVisible();
	});

	test('clicking the Team label navigates to the team org chart page', async ({
		page,
		freshWorkspace,
	}) => {
		const { team } = freshWorkspace;
		await suppressAiModal(page);
		await page.goto(`/teams/${team.slug}/tasks`);
		await waitForPageLoad(page);

		await page.locator('nav').getByRole('link', { name: 'Team' }).click();
		await expect(page).toHaveURL(new RegExp(`/teams/${team.slug}/agents/?$`), {
			timeout: 15000,
		});
		await expect(page.getByTestId('team-summary')).toBeVisible();
	});

	test('clicking the Projects label navigates to the projects list page', async ({
		page,
		freshWorkspace,
	}) => {
		const { team } = freshWorkspace;
		await suppressAiModal(page);
		await page.goto(`/teams/${team.slug}/tasks`);
		await waitForPageLoad(page);

		await page.locator('nav').getByRole('link', { name: 'Projects' }).click();
		await expect(page).toHaveURL(new RegExp(`/teams/${team.slug}/projects/?$`), {
			timeout: 15000,
		});
		await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();
	});
});

test.describe('Sidebar — Team section', () => {
	test('Team section lists agents directly and clicking an agent navigates to its detail page', async ({
		page,
		freshWorkspace,
	}) => {
		const { team, agents } = freshWorkspace;
		const captain = agents.find((a) => (a as { slug?: string }).slug === 'captain') ?? agents[0];

		await suppressAiModal(page);
		await page.goto(`/teams/${team.slug}/tasks`);
		await waitForPageLoad(page);

		const nav = page.locator('nav');
		await expect(nav.getByText('Captain')).toBeVisible({ timeout: 20000 });
		await expect(nav.getByText('Architect')).toBeVisible();

		await nav.getByText('Captain').click();
		await expect(page).toHaveURL(
			new RegExp(`/teams/${team.slug}/agents/${(captain as { slug: string }).slug}`),
			{ timeout: 15000 },
		);
	});

	test('Team section collapses, expands, and persists collapse state across navigation', async ({
		page,
		freshWorkspace,
	}) => {
		const { team } = freshWorkspace;
		await suppressAiModal(page);
		await page.goto(`/teams/${team.slug}/tasks`);
		await waitForPageLoad(page);

		const nav = page.locator('nav');
		await expect(nav.getByText('Captain')).toBeVisible({ timeout: 20000 });

		await nav.getByRole('button', { name: 'Collapse' }).nth(1).click();
		await expect(nav.getByText('Captain')).not.toBeVisible({ timeout: 15000 });

		await nav.getByText('Inbox', { exact: true }).click();
		await waitForPageLoad(page);
		await expect(nav.getByText('Captain')).not.toBeVisible();

		await nav.getByRole('button', { name: 'Expand' }).first().click();
		await expect(nav.getByText('Captain')).toBeVisible({ timeout: 15000 });
	});
});

test.describe('Sidebar — Projects section', () => {
	test('Projects section lists projects with (Internal) pinned last and click navigates to detail', async ({
		page,
		freshWorkspace,
	}) => {
		const { team, token } = freshWorkspace;

		await createProject(page, team.id, token, 'Aardvark');
		await createProject(page, team.id, token, 'Zebra');

		await suppressAiModal(page);
		await page.goto(`/teams/${team.slug}/tasks`);
		await waitForPageLoad(page);

		const nav = page.locator('nav');
		await expect(nav.getByText('(Internal)')).toBeVisible({ timeout: 20000 });
		await expect(nav.getByText('Aardvark')).toBeVisible();
		await expect(nav.getByText('Zebra')).toBeVisible();

		const links = nav.locator('a').filter({ hasText: /^(\(Internal\)|Aardvark|Zebra)$/ });
		const texts = await links.allTextContents();
		expect(texts[0]).toBe('Aardvark');
		expect(texts[1]).toBe('Zebra');
		expect(texts[2]).toBe('(Internal)');

		await nav.getByText('Aardvark').click();
		await expect(page).toHaveURL(new RegExp(`/teams/${team.slug}/projects/aardvark`), {
			timeout: 15000,
		});
	});

	test('Projects section collapses, expands, and persists collapse state across navigation', async ({
		page,
		freshWorkspace,
	}) => {
		const { team } = freshWorkspace;
		await suppressAiModal(page);
		await page.goto(`/teams/${team.slug}/tasks`);
		await waitForPageLoad(page);

		const nav = page.locator('nav');
		await expect(nav.getByText('(Internal)')).toBeVisible({ timeout: 20000 });

		await nav.getByRole('button', { name: 'Collapse' }).first().click();
		await expect(nav.getByText('(Internal)')).not.toBeVisible({ timeout: 15000 });

		await nav.getByText('Inbox', { exact: true }).click();
		await waitForPageLoad(page);
		await expect(nav.getByText('(Internal)')).not.toBeVisible();

		await nav.getByRole('button', { name: 'Expand' }).first().click();
		await expect(nav.getByText('(Internal)')).toBeVisible({ timeout: 15000 });
	});

	test('creating a project from the page or sidebar surfaces it in the sidebar after intake approval', async ({
		page,
		freshWorkspace,
	}) => {
		const { team, token } = freshWorkspace;
		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
		await suppressAiModal(page);
		await page.goto(`/teams/${team.slug}/projects`);
		await waitForPageLoad(page);

		const projectsListUrl = `/api/teams/${team.slug}/projects`;

		async function createViaDialog(
			openDialog: () => Promise<void>,
			projectName: string,
			description: string,
		): Promise<void> {
			const submitPromise = page.waitForResponse(
				(r) => r.url().endsWith(projectsListUrl) && r.request().method() === 'POST',
			);
			await openDialog();
			await page.getByLabel('Name').fill(projectName);
			await page.getByLabel('Description').fill(description);
			await page.getByRole('button', { name: 'Create' }).click();
			const intake = ((await (await submitPromise).json()) as { data: { approval_id: string } })
				.data;

			// Wait for the dialog to navigate to the intake task page before approving,
			// so the page is settled when the approval-driven project INSERT broadcasts.
			await expect(page).toHaveURL(
				new RegExp(`/teams/${team.slug}/projects/internal/tasks/[^/]+$`),
				{ timeout: 15000 },
			);

			await page.request.post(`/api/approvals/${intake.approval_id}/resolve`, {
				headers,
				data: { status: 'approved' },
			});
		}

		await createViaDialog(
			() => page.getByRole('main').getByRole('button', { name: 'New project' }).click(),
			'Page Created Project',
			'Page-button test project.',
		);
		await page.goto(`/teams/${team.slug}/projects`);
		await waitForPageLoad(page);
		const nav = page.locator('nav');
		await expect(nav.getByRole('link', { name: 'Page Created Project' }).first()).toBeVisible({
			timeout: 20000,
		});

		await createViaDialog(
			() => nav.getByRole('button', { name: 'New project' }).click(),
			'Sidebar Created Project',
			'Sidebar-button test project.',
		);
		await page.goto(`/teams/${team.slug}/projects`);
		await waitForPageLoad(page);
		await expect(nav.getByRole('link', { name: 'Sidebar Created Project' }).first()).toBeVisible({
			timeout: 20000,
		});
	});

	test('active project reveals subsection sub-links; inactive projects do not, leaving collapses them', async ({
		page,
		freshWorkspace,
	}) => {
		const { team, token } = freshWorkspace;
		const alpha = await createProject(page, team.id, token, 'Alpha');
		const beta = await createProject(page, team.id, token, 'Beta');

		await suppressAiModal(page);
		await page.goto(`/teams/${team.slug}/projects/${alpha.slug}`);
		await waitForPageLoad(page);

		const nav = page.locator('nav');
		await expect(nav.locator(`a[href$="/projects/${alpha.slug}/tasks"]`)).toBeVisible({
			timeout: 20000,
		});
		await expect(nav.locator(`a[href$="/projects/${alpha.slug}/documents"]`)).toBeVisible();
		await expect(nav.locator(`a[href$="/projects/${alpha.slug}/container"]`)).toBeVisible();
		await expect(nav.locator(`a[href$="/projects/${alpha.slug}/settings"]`)).toBeVisible();

		await expect(nav.locator(`a[href$="/projects/${beta.slug}/tasks"]`)).toHaveCount(0);
		await expect(nav.locator(`a[href$="/projects/${beta.slug}/settings"]`)).toHaveCount(0);

		await nav.locator(`a[href$="/projects/${alpha.slug}/documents"]`).click();
		await expect(page).toHaveURL(
			new RegExp(`/teams/${team.slug}/projects/${alpha.slug}/documents`),
			{ timeout: 15000 },
		);
		await expect(nav.locator(`a[href$="/projects/${alpha.slug}/settings"]`)).toBeVisible();

		await nav.getByText('Inbox', { exact: true }).click();
		await waitForPageLoad(page);
		await expect(nav.locator(`a[href$="/projects/${alpha.slug}/settings"]`)).toHaveCount(0);
	});
});

test.describe('Sidebar — Tasks count and mobile drawer', () => {
	test('sidebar Tasks count reflects non-terminal tasks and updates live', async ({
		page,
		freshWorkspace,
	}) => {
		const { team, agents, token } = freshWorkspace;
		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

		const project = await createProjectAndClearPlanning(page, team.id, token, {
			name: 'Count Project',
			description: 'Sidebar count test.',
		});
		await waitForCaptainIdle(page, team.id, token);

		const taskIds: string[] = [];
		for (const title of ['Alpha', 'Beta', 'Gamma']) {
			const r = await page.request.post(`/api/teams/${team.id}/tasks`, {
				headers,
				data: { project_id: project.id, title, assignee_id: agents[0].id },
			});
			taskIds.push(((await r.json()) as { data: { id: string } }).data.id);
		}

		const readOpenCount = async () => {
			const r = await page.request.get(`/api/teams/${team.slug}`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			return ((await r.json()) as { data: { open_task_count: number } }).data.open_task_count;
		};

		await page.goto(`/teams/${team.slug}/tasks`);
		await waitForPageLoad(page);

		const sidebarTasks = page.getByTestId('sidebar-link-tasks');
		await expect(sidebarTasks).toContainText('Tasks');
		const openAfterCreate = await readOpenCount();
		await expect(sidebarTasks).toContainText(String(openAfterCreate), { timeout: 15000 });

		await page.request.patch(`/api/teams/${team.id}/tasks/${taskIds[0]}`, {
			headers,
			data: { status: 'closed' },
		});

		await expect.poll(readOpenCount, { timeout: 15000 }).toBe(openAfterCreate - 1);
		await expect(sidebarTasks).toContainText(String(openAfterCreate - 1), { timeout: 15000 });
	});

	test('mobile viewport opens navigation via hamburger drawer', async ({
		page,
		freshWorkspace,
	}) => {
		await page.setViewportSize({ width: 375, height: 812 });
		const { team } = freshWorkspace;

		await page.goto(`/teams/${team.slug}/tasks`);
		await waitForPageLoad(page);

		await expect(page.getByTestId('sidebar-link-tasks')).toBeHidden();

		const toggle = page.getByTestId('mobile-nav-toggle');
		await expect(toggle).toBeVisible();
		await toggle.click();

		const drawer = page.getByTestId('mobile-nav-drawer');
		await expect(drawer).toBeVisible();
		await expect(drawer.getByTestId('sidebar-link-tasks')).toBeVisible();

		await page.getByTestId('mobile-nav-close').click();
		await expect(drawer).toBeHidden();
	});
});

test.describe('Sidebar — collapse', () => {
	test('sidebar can be collapsed and the state persists across reload', async ({
		page,
		freshWorkspace,
	}) => {
		const { team } = freshWorkspace;
		await page.goto(`/teams/${team.slug}/inbox`);

		await expect(page.getByText('Resources').first()).toBeVisible({ timeout: 20000 });

		const toggle = page.getByTestId('sidebar-toggle');
		await expect(toggle).toBeVisible();
		await expect(toggle).toHaveAccessibleName('Collapse sidebar');

		const [uiStateResponse] = await Promise.all([
			page.waitForResponse(
				(r) => r.url().includes('/ui-state') && r.request().method() === 'PATCH',
			),
			toggle.click(),
		]);
		expect(uiStateResponse.ok()).toBe(true);
		await expect(toggle).toHaveAccessibleName('Expand sidebar', { timeout: 15000 });
		await expect(page.getByText('Resources').first()).toBeHidden({ timeout: 15000 });

		await page.reload();
		await expect(page.getByTestId('sidebar-toggle')).toHaveAccessibleName('Expand sidebar', {
			timeout: 20000,
		});
		await expect(page.getByText('Resources').first()).toBeHidden({ timeout: 15000 });

		await page.getByTestId('sidebar-toggle').click();
		await expect(page.getByText('Resources').first()).toBeVisible({ timeout: 15000 });
	});

	test('sidebar toggle stays clickable when the container status banner is showing', async ({
		page,
		freshWorkspace,
	}) => {
		const { team } = freshWorkspace;

		const fakeProject = {
			id: '11111111-1111-1111-1111-000000000099',
			team_id: team.id,
			name: 'Banner Regression Project',
			slug: 'banner-regression-project',
			task_prefix: 'BR',
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
		};

		await page.route(`**/api/teams/*/projects`, async (route) => {
			if (route.request().method() !== 'GET') return route.continue();
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ data: [fakeProject] }),
			});
		});

		await page.goto(`/teams/${team.slug}/inbox`);

		await expect(page.getByTestId('container-status-banner')).toBeVisible({ timeout: 20000 });
		await expect(page.getByTestId('container-status-banner')).toContainText(/container failed/i);

		const toggle = page.getByTestId('sidebar-toggle');
		await expect(toggle).toBeVisible();
		await expect(toggle).toHaveAccessibleName('Collapse sidebar');

		await toggle.click();
		await expect(toggle).toHaveAccessibleName('Expand sidebar', { timeout: 15000 });
	});
});
