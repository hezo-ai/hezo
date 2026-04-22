import { expect, test } from '@playwright/test';
import { authenticate, createCompanyWithAgents, waitForPageLoad } from './helpers';

test.describe('Project CRUD', () => {
	test('creates a project via dialog and opens a CEO planning ticket', async ({ page }) => {
		await authenticate(page);
		const { company } = await createCompanyWithAgents(page);

		await page.goto(`/companies/${company.slug}/projects`);
		await waitForPageLoad(page);

		await page.getByRole('main').getByRole('button', { name: 'New project' }).click();

		await page.getByLabel('Name').fill('Marketing Campaign');
		await page
			.getByLabel('Description')
			.fill('Q3 brand push aimed at existing users to drive upsells.');

		await page.getByRole('button', { name: 'Create' }).click();

		await expect(
			page,
			'expected canonical project-scoped issue URL after creating a project',
		).toHaveURL(
			new RegExp(`/companies/${company.slug}/projects/[a-z0-9-]+/issues/[a-z0-9-]+(?:#.*)?$`),
			{ timeout: 5000 },
		);
		await expect(
			page.getByRole('main').getByText('Draft execution plan for "Marketing Campaign"'),
		).toBeVisible({ timeout: 5000 });

		const description = page.getByTestId('issue-description');
		await expect(description).toBeVisible({ timeout: 5000 });
		const paragraphMarginBottom = await description
			.locator('p')
			.first()
			.evaluate((el) => Number.parseFloat(getComputedStyle(el).marginBottom));
		expect(paragraphMarginBottom).toBeGreaterThan(0);
		const headingFontWeight = await description
			.locator('h2')
			.first()
			.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontWeight));
		expect(headingFontWeight).toBeGreaterThanOrEqual(600);
		const listStyle = await description
			.locator('ol')
			.first()
			.evaluate((el) => getComputedStyle(el).listStyleType);
		expect(listStyle).not.toBe('none');
	});

	test('project list shows default Operations project', async ({ page }) => {
		await authenticate(page);
		const { company } = await createCompanyWithAgents(page);

		await page.goto(`/companies/${company.slug}/projects`);
		await waitForPageLoad(page);

		await expect(page.getByRole('heading', { name: 'Operations' })).toBeVisible({ timeout: 5000 });
	});

	test('project list shows issue and repo counts', async ({ page }) => {
		await authenticate(page);
		const { company, token } = await createCompanyWithAgents(page);
		const headers = { Authorization: `Bearer ${token}` };

		// Create a project via API
		await page.request.post(`/api/companies/${company.id}/projects`, {
			headers,
			data: { name: 'Count Test', description: 'Count test project.' },
		});

		await page.goto(`/companies/${company.slug}/projects`);
		await waitForPageLoad(page);

		const card = page.getByRole('main').locator('a', { hasText: 'Count Test' });
		await expect(card).toBeVisible({ timeout: 5000 });
		await expect(card.getByText('1 issues')).toBeVisible();
		await expect(card.getByText('0 repos')).toBeVisible();
	});

	test('project card links to project detail', async ({ page }) => {
		await authenticate(page);
		const { company, token } = await createCompanyWithAgents(page);
		const headers = { Authorization: `Bearer ${token}` };

		const projRes = await page.request.post(`/api/companies/${company.id}/projects`, {
			headers,
			data: { name: 'Linkable Project', description: 'Linkable project description.' },
		});
		const project = ((await projRes.json()) as any).data;

		await page.goto(`/companies/${company.slug}/projects`);
		await waitForPageLoad(page);

		await page.getByRole('main').getByRole('heading', { name: 'Linkable Project' }).click();

		// Should navigate to project detail page
		await expect(page).toHaveURL(
			new RegExp(`/companies/${company.slug}/projects/${project.slug}`),
			{ timeout: 5000 },
		);
	});

	test('creates a project with initial PRD and saves it as project doc', async ({ page }) => {
		await authenticate(page);
		const { company, token } = await createCompanyWithAgents(page);
		const headers = { Authorization: `Bearer ${token}` };

		const prdContent = '# Widget App\n\nA tool for managing widgets efficiently.';

		const projRes = await page.request.post(`/api/companies/${company.id}/projects`, {
			headers,
			data: {
				name: 'PRD Test Project',
				description: 'Testing initial PRD upload.',
				initial_prd: prdContent,
			},
		});
		expect(projRes.ok()).toBe(true);
		const project = ((await projRes.json()) as any).data;

		const docRes = await page.request.get(
			`/api/companies/${company.id}/projects/${project.id}/docs/initial-prd.md`,
			{ headers },
		);
		expect(docRes.ok()).toBe(true);
		const doc = ((await docRes.json()) as any).data;
		expect(doc.content).toBe(prdContent);
		expect(doc.filename).toBe('initial-prd.md');
	});

	test('create button is disabled without name', async ({ page }) => {
		await authenticate(page);
		const { company } = await createCompanyWithAgents(page);

		await page.goto(`/companies/${company.slug}/projects`);
		await waitForPageLoad(page);

		await page.getByRole('main').getByRole('button', { name: 'New project' }).click();

		// Create button should be disabled when name or description is empty
		const createBtn = page.getByRole('button', { name: 'Create' });
		await expect(createBtn).toBeDisabled();

		// Fill name alone — still disabled because description is required
		await page.getByLabel('Name').fill('My Project');
		await expect(createBtn).toBeDisabled();

		// Fill description — now it should be enabled
		await page.getByLabel('Description').fill('A short project description.');
		await expect(createBtn).toBeEnabled();
	});
});
