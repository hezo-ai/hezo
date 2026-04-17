import { expect, test } from '@playwright/test';
import { authenticate, createCompanyWithAgents, waitForPageLoad } from './helpers';

test.describe('Goals', () => {
	test('creates a company-wide goal from the Goals page and opens a CEO ticket', async ({
		page,
	}) => {
		await authenticate(page);
		const { company } = await createCompanyWithAgents(page);

		await page.goto(`/companies/${company.slug}/goals`);
		await waitForPageLoad(page);

		await page.getByRole('button', { name: 'New goal' }).click();

		await page.getByLabel('Title').fill('Raise seed round');
		await page.getByLabel('Description').fill('Close a $2M seed by end of Q3.');

		await page.getByRole('button', { name: 'Create' }).click();

		const main = page.getByRole('main');
		await expect(main.getByText('Raise seed round')).toBeVisible({ timeout: 5000 });
		await expect(main.getByText('Company-wide').first()).toBeVisible();

		// The CEO ticket lives in the Operations project.
		await page.goto(`/companies/${company.slug}/projects/operations/issues`);
		await waitForPageLoad(page);
		await expect(
			page.getByRole('main').getByText('Review plans for goal: "Raise seed round"'),
		).toBeVisible({ timeout: 5000 });
	});

	test('project-scoped goal routes the CEO ticket into that project', async ({ page }) => {
		await authenticate(page);
		const { company, token } = await createCompanyWithAgents(page);
		const headers = { Authorization: `Bearer ${token}` };

		const projRes = await page.request.post(`/api/companies/${company.id}/projects`, {
			headers,
			data: { name: 'Growth', description: 'Growth engineering workstream.' },
		});
		const project = ((await projRes.json()) as { data: { id: string; slug: string } }).data;

		await page.goto(`/companies/${company.slug}/goals`);
		await waitForPageLoad(page);

		await page.getByRole('button', { name: 'New goal' }).click();
		await page.getByLabel('Title').fill('Launch public v1');
		await page.getByLabel('Description').fill('Ship the API to the public.');
		await page.getByLabel('Scope').selectOption({ label: 'Growth' });
		await page.getByRole('button', { name: 'Create' }).click();

		await expect(page.getByRole('main').getByText('Launch public v1')).toBeVisible({
			timeout: 5000,
		});

		await page.goto(`/companies/${company.slug}/projects/${project.slug}/issues`);
		await waitForPageLoad(page);
		await expect(
			page.getByRole('main').getByText('Review plans for goal: "Launch public v1"'),
		).toBeVisible({ timeout: 5000 });
	});
});
