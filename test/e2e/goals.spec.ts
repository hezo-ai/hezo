import { expect, test } from '@playwright/test';
import { authenticate, createTeamWithAgents, waitForPageLoad } from './helpers';

test.describe('Goals', () => {
	test('creates a team-wide goal from the Goals page and opens a CEO ticket', async ({ page }) => {
		await authenticate(page);
		const { team } = await createTeamWithAgents(page);

		await page.goto(`/teams/${team.slug}/goals`);
		await waitForPageLoad(page);

		await page.getByRole('button', { name: 'New goal' }).click();

		await page.getByLabel('Title').fill('Raise seed round');
		await page.getByLabel('Description').fill('Close a $2M seed by end of Q3.');

		await page.getByRole('button', { name: 'Create' }).click();

		const main = page.getByRole('main');
		await expect(main.getByText('Raise seed round')).toBeVisible({ timeout: 15000 });
		await expect(main.getByText('Team-wide').first()).toBeVisible();

		// The CEO ticket lives in the Operations project.
		await page.goto(`/teams/${team.slug}/projects/operations/issues`);
		await waitForPageLoad(page);
		await expect(
			page.getByRole('main').getByText('Review plans for goal: "Raise seed round"'),
		).toBeVisible({ timeout: 15000 });
	});

	test('project-scoped goal routes the CEO ticket into that project', async ({ page }) => {
		await authenticate(page);
		const { team, token } = await createTeamWithAgents(page);
		const headers = { Authorization: `Bearer ${token}` };

		const projRes = await page.request.post(`/api/teams/${team.id}/projects`, {
			headers,
			data: { name: 'Growth', description: 'Growth engineering workstream.' },
		});
		const project = ((await projRes.json()) as { data: { id: string; slug: string } }).data;

		await page.goto(`/teams/${team.slug}/goals`);
		await waitForPageLoad(page);

		await page.getByRole('button', { name: 'New goal' }).click();
		await page.getByLabel('Title').fill('Launch public v1');
		await page.getByLabel('Description').fill('Ship the API to the public.');
		await page.getByLabel('Scope').selectOption({ label: 'Growth' });
		await page.getByRole('button', { name: 'Create' }).click();

		await expect(page.getByRole('main').getByText('Launch public v1')).toBeVisible({
			timeout: 15000,
		});

		await page.goto(`/teams/${team.slug}/projects/${project.slug}/issues`);
		await waitForPageLoad(page);
		await expect(
			page.getByRole('main').getByText('Review plans for goal: "Launch public v1"'),
		).toBeVisible({ timeout: 15000 });
	});
});
