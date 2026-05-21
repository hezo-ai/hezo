import { expect, test } from './fixtures';
import { createProjectAndClearPlanning, waitForPageLoad } from './helpers';

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
	const res = await page.request.post(`/api/teams/${teamId}/projects`, {
		headers,
		data: { name, description: 'Test project.' },
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
		await page.goto(`/teams/${team.slug}/issues`);
		await waitForPageLoad(page);

		const nav = page.locator('nav');
		await expect(nav.getByText('Inbox', { exact: true })).toBeVisible();
		await expect(nav.getByText('Work', { exact: true })).toBeVisible();
		await expect(nav.getByText('Projects', { exact: true })).toBeVisible();
		await expect(nav.getByText('Team', { exact: true })).toBeVisible();
		await expect(nav.getByText('Resources', { exact: true })).toBeVisible();
		await expect(nav.getByRole('link', { name: 'Issues' })).toBeVisible();
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
		await page.goto(`/teams/${team.slug}/issues`);
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
		await page.goto(`/teams/${team.slug}/issues`);
		await waitForPageLoad(page);

		await page.locator('nav').getByRole('link', { name: 'Projects' }).click();
		await expect(page).toHaveURL(new RegExp(`/teams/${team.slug}/projects/?$`), {
			timeout: 15000,
		});
		await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();
	});
});

test.describe('Main rail — team members', () => {
	test('home page shows team member avatars on the main rail', async ({ page, freshWorkspace }) => {
		const { team } = freshWorkspace;
		await suppressAiModal(page);
		await page.goto('/home');
		await waitForPageLoad(page);

		const rail = page.getByTestId('team-rail-members');
		await expect(rail).toBeVisible({ timeout: 20000 });
		await expect(rail.getByRole('link', { name: 'Captain' })).toBeVisible();
		await expect(page).toHaveURL(/\/home\/?$/);
	});

	test('sidebar does not list agent names; rail shows avatars that link to agent pages', async ({
		page,
		freshWorkspace,
	}) => {
		const { team, agents } = freshWorkspace;
		const captain = agents.find((a) => (a as { slug?: string }).slug === 'captain') ?? agents[0];

		await suppressAiModal(page);
		await page.goto(`/teams/${team.slug}/issues`);
		await waitForPageLoad(page);

		const nav = page.locator('nav');
		await expect(nav.getByText('Captain')).not.toBeVisible();
		await expect(nav.getByText('Architect')).not.toBeVisible();

		const rail = page.getByTestId('team-rail-members');
		await expect(rail).toBeVisible({ timeout: 20000 });
		const memberLinks = rail.getByTestId('team-rail-member');
		await expect(memberLinks).not.toHaveCount(0);

		await rail.getByRole('link', { name: 'Captain' }).click();
		await expect(page).toHaveURL(
			new RegExp(`/teams/${team.slug}/agents/${(captain as { slug: string }).slug}`),
			{ timeout: 15000 },
		);
	});

	test('projects list page shows team member avatars on the main rail', async ({
		page,
		freshWorkspace,
	}) => {
		const { team } = freshWorkspace;
		await suppressAiModal(page);
		await page.goto(`/teams/${team.slug}/projects`);
		await waitForPageLoad(page);

		await expect(page.getByTestId('team-rail-members')).toBeVisible({ timeout: 20000 });
	});

	test('mobile drawer includes team member avatars on the main rail', async ({
		page,
		freshWorkspace,
	}) => {
		await page.setViewportSize({ width: 375, height: 812 });
		const { team } = freshWorkspace;

		await suppressAiModal(page);
		await page.goto(`/teams/${team.slug}/issues`);
		await waitForPageLoad(page);

		await page.getByTestId('mobile-nav-toggle').click();
		const drawer = page.getByTestId('mobile-nav-drawer');
		await expect(drawer.getByTestId('team-rail-members')).toBeVisible({ timeout: 20000 });
	});
});

test.describe('Sidebar — Projects section', () => {
	test('Projects section lists projects with Operations pinned first and click navigates to detail', async ({
		page,
		freshWorkspace,
	}) => {
		const { team, token } = freshWorkspace;

		await createProject(page, team.id, token, 'Aardvark');
		await createProject(page, team.id, token, 'Zebra');

		await suppressAiModal(page);
		await page.goto(`/teams/${team.slug}/issues`);
		await waitForPageLoad(page);

		const nav = page.locator('nav');
		await expect(nav.getByText('Operations')).toBeVisible({ timeout: 20000 });
		await expect(nav.getByText('Aardvark')).toBeVisible();
		await expect(nav.getByText('Zebra')).toBeVisible();

		const links = nav.locator('a').filter({ hasText: /^(Operations|Aardvark|Zebra)$/ });
		const texts = await links.allTextContents();
		expect(texts[0]).toBe('Operations');
		expect(texts[1]).toBe('Aardvark');
		expect(texts[2]).toBe('Zebra');

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
		await page.goto(`/teams/${team.slug}/issues`);
		await waitForPageLoad(page);

		const nav = page.locator('nav');
		await expect(nav.getByText('Operations')).toBeVisible({ timeout: 20000 });

		await nav.getByRole('button', { name: 'Collapse' }).first().click();
		await expect(nav.getByText('Operations')).not.toBeVisible({ timeout: 15000 });

		await nav.getByText('Inbox', { exact: true }).click();
		await waitForPageLoad(page);
		await expect(nav.getByText('Operations')).not.toBeVisible();

		await nav.getByRole('button', { name: 'Expand' }).first().click();
		await expect(nav.getByText('Operations')).toBeVisible({ timeout: 15000 });
	});

	test('creating a project from the page or sidebar appears in the sidebar without reload', async ({
		page,
		freshWorkspace,
	}) => {
		const { team } = freshWorkspace;
		await suppressAiModal(page);
		await page.goto(`/teams/${team.slug}/projects`);
		await waitForPageLoad(page);

		await page.getByRole('main').getByRole('button', { name: 'New project' }).click();
		await page.getByLabel('Name').fill('Page Created Project');
		await page.getByLabel('Description').fill('Page-button test project.');
		await page.getByRole('button', { name: 'Create' }).click();

		const nav = page.locator('nav');
		await expect(nav.getByRole('link', { name: 'Page Created Project' }).first()).toBeVisible({
			timeout: 20000,
		});

		await nav.getByRole('button', { name: 'New project' }).click();
		await page.getByLabel('Name').fill('Sidebar Created Project');
		await page.getByLabel('Description').fill('Sidebar-button test project.');
		await page.getByRole('button', { name: 'Create' }).click();

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
		await expect(nav.locator(`a[href$="/projects/${alpha.slug}/issues"]`)).toBeVisible({
			timeout: 20000,
		});
		await expect(nav.locator(`a[href$="/projects/${alpha.slug}/documents"]`)).toBeVisible();
		await expect(nav.locator(`a[href$="/projects/${alpha.slug}/container"]`)).toBeVisible();
		await expect(nav.locator(`a[href$="/projects/${alpha.slug}/settings"]`)).toBeVisible();

		await expect(nav.locator(`a[href$="/projects/${beta.slug}/issues"]`)).toHaveCount(0);
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

test.describe('Sidebar — Issues count and mobile drawer', () => {
	test('sidebar Issues count reflects non-terminal issues and updates live', async ({
		page,
		freshWorkspace,
	}) => {
		const { team, agents, token } = freshWorkspace;
		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
		const teamRes = await page.request.get(`/api/teams/${team.slug}`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		const baselineOpen = ((await teamRes.json()) as { data: { open_issue_count: number } }).data
			.open_issue_count;

		const project = await createProjectAndClearPlanning(page, team.id, token, {
			name: 'Count Project',
			description: 'Sidebar count test.',
		});

		const issueIds: string[] = [];
		for (const title of ['Alpha', 'Beta', 'Gamma']) {
			const r = await page.request.post(`/api/teams/${team.id}/issues`, {
				headers,
				data: { project_id: project.id, title, assignee_id: agents[0].id },
			});
			issueIds.push(((await r.json()) as { data: { id: string } }).data.id);
		}

		await page.goto(`/teams/${team.slug}/issues`);
		await waitForPageLoad(page);

		const sidebarIssues = page.getByTestId('sidebar-link-issues');
		await expect(sidebarIssues).toContainText('Issues');
		const expectedOpen = baselineOpen + 3;
		await expect(sidebarIssues).toContainText(String(expectedOpen));

		await page.request.patch(`/api/teams/${team.id}/issues/${issueIds[0]}`, {
			headers,
			data: { status: 'closed' },
		});

		await expect(sidebarIssues).toContainText(String(expectedOpen - 1), { timeout: 15000 });
		await expect(sidebarIssues).not.toContainText(String(expectedOpen));
	});

	test('mobile viewport opens navigation via hamburger drawer', async ({
		page,
		freshWorkspace,
	}) => {
		await page.setViewportSize({ width: 375, height: 812 });
		const { team } = freshWorkspace;

		await page.goto(`/teams/${team.slug}/issues`);
		await waitForPageLoad(page);

		await expect(page.getByTestId('sidebar-link-issues')).toBeHidden();

		const toggle = page.getByTestId('mobile-nav-toggle');
		await expect(toggle).toBeVisible();
		await toggle.click();

		const drawer = page.getByTestId('mobile-nav-drawer');
		await expect(drawer).toBeVisible();
		await expect(drawer.getByTestId('sidebar-link-issues')).toBeVisible();

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
			issue_prefix: 'BR',
			description: '',
			docker_base_image: null,
			container_id: null,
			container_status: 'error',
			container_error: 'simulated build failure',
			container_last_logs: null,
			dev_ports: [],
			repo_count: 0,
			open_issue_count: 0,
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
