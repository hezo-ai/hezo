import { expect, type Page, test } from '@playwright/test';
import { authenticate, createCompanyWithAgents, waitForPageLoad } from './helpers';

async function suppressAiModal(page: Page) {
	await page.route('**/ai-providers/status', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ data: { configured: true } }),
		}),
	);
}

test.describe('Sidebar Navigation', () => {
	test('displays all sidebar sections', async ({ page }) => {
		await authenticate(page);
		const { company } = await createCompanyWithAgents(page);

		await suppressAiModal(page);
		await page.goto(`/companies/${company.slug}/issues`);
		await waitForPageLoad(page);

		const nav = page.locator('nav');
		await expect(nav.getByText('Inbox', { exact: true })).toBeVisible();
		await expect(nav.getByText('Work', { exact: true })).toBeVisible();
		await expect(nav.getByText('Projects', { exact: true })).toBeVisible();
		await expect(nav.getByText('Team', { exact: true })).toBeVisible();
		await expect(nav.getByText('Resources', { exact: true })).toBeVisible();
	});

	test('does not show "All agents" link', async ({ page }) => {
		await authenticate(page);
		const { company } = await createCompanyWithAgents(page);

		await suppressAiModal(page);
		await page.goto(`/companies/${company.slug}/issues`);
		await waitForPageLoad(page);

		const nav = page.locator('nav');
		await expect(nav.getByText('All agents')).not.toBeVisible();
	});

	test('Team section lists agents directly as children', async ({ page }) => {
		await authenticate(page);
		const { company } = await createCompanyWithAgents(page);

		await suppressAiModal(page);
		await page.goto(`/companies/${company.slug}/issues`);
		await waitForPageLoad(page);

		const nav = page.locator('nav');

		// Team is expanded by default — agents should be visible
		await expect(nav.getByText('CEO')).toBeVisible({ timeout: 10000 });
		await expect(nav.getByText('Architect')).toBeVisible();
	});

	test('Team section collapses and expands', async ({ page }) => {
		await authenticate(page);
		const { company } = await createCompanyWithAgents(page);

		await suppressAiModal(page);
		await page.goto(`/companies/${company.slug}/issues`);
		await waitForPageLoad(page);

		const nav = page.locator('nav');
		const teamHeader = nav.getByText('Team', { exact: true });

		// Expanded by default — agents visible
		await expect(nav.getByText('CEO')).toBeVisible({ timeout: 10000 });

		// Collapse
		await teamHeader.click();
		await expect(nav.getByText('CEO')).not.toBeVisible({ timeout: 5000 });

		// Expand again
		await teamHeader.click();
		await expect(nav.getByText('CEO')).toBeVisible({ timeout: 5000 });
	});

	test('Team collapse state persists across navigation', async ({ page }) => {
		await authenticate(page);
		const { company } = await createCompanyWithAgents(page);

		await suppressAiModal(page);
		await page.goto(`/companies/${company.slug}/issues`);
		await waitForPageLoad(page);

		const nav = page.locator('nav');

		// Collapse Team
		await nav.getByText('Team', { exact: true }).click();
		await expect(nav.getByText('CEO')).not.toBeVisible({ timeout: 5000 });

		// Navigate to a different page
		await nav.getByText('Inbox', { exact: true }).click();
		await waitForPageLoad(page);

		// Team should still be collapsed
		await expect(nav.getByText('CEO')).not.toBeVisible();
	});

	test('Projects section is expanded by default and lists project names', async ({ page }) => {
		await authenticate(page);
		const { company, token } = await createCompanyWithAgents(page);
		const headers = { Authorization: `Bearer ${token}` };

		// Create additional projects
		await page.request.post(`/api/companies/${company.id}/projects`, {
			headers,
			data: { name: 'Alpha' },
		});
		await page.request.post(`/api/companies/${company.id}/projects`, {
			headers,
			data: { name: 'Beta' },
		});

		await suppressAiModal(page);
		await page.goto(`/companies/${company.slug}/issues`);
		await waitForPageLoad(page);

		const nav = page.locator('nav');

		// Projects expanded by default — should list project names
		await expect(nav.getByText('Operations')).toBeVisible({ timeout: 10000 });
		await expect(nav.getByText('Alpha')).toBeVisible();
		await expect(nav.getByText('Beta')).toBeVisible();
	});

	test('Projects section shows Operations first regardless of creation order', async ({ page }) => {
		await authenticate(page);
		const { company, token } = await createCompanyWithAgents(page);
		const headers = { Authorization: `Bearer ${token}` };

		// Create projects in alphabetical order that would sort before "Operations"
		await page.request.post(`/api/companies/${company.id}/projects`, {
			headers,
			data: { name: 'Aardvark' },
		});
		await page.request.post(`/api/companies/${company.id}/projects`, {
			headers,
			data: { name: 'Zebra' },
		});

		await suppressAiModal(page);
		await page.goto(`/companies/${company.slug}/issues`);
		await waitForPageLoad(page);

		const nav = page.locator('nav');
		await expect(nav.getByText('Operations')).toBeVisible({ timeout: 10000 });

		// Get all project links within the Projects section
		// Operations should appear before Aardvark in DOM order
		const projectLinks = nav.locator('a').filter({ hasText: /^(Operations|Aardvark|Zebra)$/ });
		const texts = await projectLinks.allTextContents();

		expect(texts[0]).toBe('Operations');
		expect(texts[1]).toBe('Aardvark');
		expect(texts[2]).toBe('Zebra');
	});

	test('Projects section collapses and expands via chevron', async ({ page }) => {
		await authenticate(page);
		const { company } = await createCompanyWithAgents(page);

		await suppressAiModal(page);
		await page.goto(`/companies/${company.slug}/issues`);
		await waitForPageLoad(page);

		const nav = page.locator('nav');

		// Expanded by default — Operations visible
		await expect(nav.getByText('Operations')).toBeVisible({ timeout: 10000 });

		// Collapse via chevron
		await nav.getByRole('button', { name: 'Collapse' }).first().click();
		await expect(nav.getByText('Operations')).not.toBeVisible({ timeout: 5000 });

		// Expand again
		await nav.getByRole('button', { name: 'Expand' }).first().click();
		await expect(nav.getByText('Operations')).toBeVisible({ timeout: 5000 });
	});

	test('Projects collapse state persists across navigation', async ({ page }) => {
		await authenticate(page);
		const { company } = await createCompanyWithAgents(page);

		await suppressAiModal(page);
		await page.goto(`/companies/${company.slug}/issues`);
		await waitForPageLoad(page);

		const nav = page.locator('nav');

		// Collapse Projects via chevron
		await nav.getByRole('button', { name: 'Collapse' }).first().click();
		await expect(nav.getByText('Operations')).not.toBeVisible({ timeout: 5000 });

		// Navigate away
		await nav.getByText('Inbox', { exact: true }).click();
		await waitForPageLoad(page);

		// Projects should still be collapsed
		await expect(nav.getByText('Operations')).not.toBeVisible();
	});

	test('clicking Projects label navigates to projects list page', async ({ page }) => {
		await authenticate(page);
		const { company } = await createCompanyWithAgents(page);

		await suppressAiModal(page);
		await page.goto(`/companies/${company.slug}/issues`);
		await waitForPageLoad(page);

		const nav = page.locator('nav');
		await nav.getByRole('link', { name: 'Projects' }).click();

		await expect(page).toHaveURL(new RegExp(`/companies/${company.slug}/projects/?$`), {
			timeout: 5000,
		});
		await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();
	});

	test('sidebar + button creates a project and it shows in grid and sidebar', async ({ page }) => {
		await authenticate(page);
		const { company } = await createCompanyWithAgents(page);

		await suppressAiModal(page);
		await page.goto(`/companies/${company.slug}/projects`);
		await waitForPageLoad(page);

		const nav = page.locator('nav');
		await nav.getByRole('button', { name: 'New project' }).click();

		await page.getByLabel('Name').fill('Sidebar Created Project');
		await page.getByRole('button', { name: 'Create' }).click();

		// Appears in the sidebar
		await expect(nav.getByText('Sidebar Created Project')).toBeVisible({ timeout: 10000 });

		// Appears in the page grid
		await expect(page.getByRole('main').getByText('Sidebar Created Project')).toBeVisible();
	});

	test('clicking a project in sidebar navigates to project detail', async ({ page }) => {
		await authenticate(page);
		const { company, token } = await createCompanyWithAgents(page);
		const headers = { Authorization: `Bearer ${token}` };

		const projRes = await page.request.post(`/api/companies/${company.id}/projects`, {
			headers,
			data: { name: 'Nav Test Project' },
		});
		const project = ((await projRes.json()) as any).data;

		await suppressAiModal(page);
		await page.goto(`/companies/${company.slug}/issues`);
		await waitForPageLoad(page);

		const nav = page.locator('nav');
		await nav.getByText('Nav Test Project').click();

		await expect(page).toHaveURL(
			new RegExp(`/companies/${company.slug}/projects/${project.slug}`),
			{ timeout: 5000 },
		);
	});

	test('clicking an agent in sidebar navigates to agent detail', async ({ page }) => {
		await authenticate(page);
		const { company, token } = await createCompanyWithAgents(page);

		const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		const agents = ((await agentsRes.json()) as any).data as { id: string; title: string }[];
		const ceo = agents.find((a) => a.title === 'CEO')!;

		await suppressAiModal(page);
		await page.goto(`/companies/${company.slug}/issues`);
		await waitForPageLoad(page);

		const nav = page.locator('nav');
		await nav.getByText('CEO').click();

		await expect(page).toHaveURL(new RegExp(`/companies/${company.slug}/agents/${ceo.id}`), {
			timeout: 5000,
		});
	});

	test('Work section contains Issues link and Projects label is a link', async ({ page }) => {
		await authenticate(page);
		const { company } = await createCompanyWithAgents(page);

		await suppressAiModal(page);
		await page.goto(`/companies/${company.slug}/issues`);
		await waitForPageLoad(page);

		const nav = page.locator('nav');

		// Issues should be a link under Work
		await expect(nav.getByRole('link', { name: 'Issues' })).toBeVisible();

		// Projects label is now a link that navigates to the projects page
		await expect(nav.getByRole('link', { name: 'Projects' })).toBeVisible();
	});

	test('newly created project appears in sidebar without reload', async ({ page }) => {
		await authenticate(page);
		const { company } = await createCompanyWithAgents(page);

		await suppressAiModal(page);
		await page.goto(`/companies/${company.slug}/projects`);
		await waitForPageLoad(page);

		// Create a project via the page header button
		await page.getByRole('main').getByRole('button', { name: 'New project' }).click();
		await page.getByLabel('Name').fill('Dynamic Sidebar Project');
		await page.getByRole('button', { name: 'Create' }).click();

		// Verify it appears in the sidebar
		const nav = page.locator('nav');
		await expect(nav.getByText('Dynamic Sidebar Project')).toBeVisible({ timeout: 10000 });
	});
});
