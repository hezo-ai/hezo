import { expect, test } from '@playwright/test';
import {
	authenticate,
	createProjectAndClearPlanning,
	createTeamWithAgents,
	saveAndWaitForRefetch,
	waitForPageLoad,
} from './helpers';

test.describe('Goals', () => {
	test('creates a team-wide goal from the Goals page and opens a Captain ticket', async ({
		page,
	}) => {
		await authenticate(page);
		const { team, token } = await createTeamWithAgents(page);

		const projRes = await createProjectAndClearPlanning(page, team.id, token, {
			name: 'Goals Product',
			description: 'Primary product workstream for goals e2e.',
		});
		expect(projRes.ok()).toBe(true);

		await page.goto(`/teams/${team.slug}/goals`);
		await waitForPageLoad(page);

		await page.getByRole('button', { name: 'New goal' }).click();

		await page.getByLabel('Title').fill('Raise seed round');
		await page.getByLabel('Description').fill('Close a $2M seed by end of Q3.');

		const goalsUrl = `/teams/${team.slug}/goals`;
		const { mutation: createResp } = await saveAndWaitForRefetch(
			page,
			page.getByRole('button', { name: 'Create' }),
			{
				mutation: (url, method) => url.pathname.endsWith(goalsUrl) && method === 'POST',
				refetch: (url, method) => url.pathname.endsWith(goalsUrl) && method === 'GET',
			},
		);
		expect(createResp.ok(), `POST /goals failed: ${await createResp.text()}`).toBe(true);

		const main = page.getByRole('main');
		await expect(main.getByText('Raise seed round')).toBeVisible({ timeout: 30000 });
		await expect(main.getByText('Team-wide').first()).toBeVisible();

		// The Captain ticket lives in the Internal project.
		await page.goto(`/teams/${team.slug}/projects/internal/tasks`);
		await waitForPageLoad(page);
		await expect(
			page.getByRole('main').getByText('Review plans for goal: "Raise seed round"'),
		).toBeVisible({ timeout: 15000 });
	});

	test('project-scoped goal routes the Captain ticket into that project', async ({ page }) => {
		await authenticate(page);
		const { team, token } = await createTeamWithAgents(page);

		const projRes = await createProjectAndClearPlanning(page, team.id, token, {
			name: 'Growth',
			description: 'Growth engineering workstream.',
		});
		const project = ((await projRes.json()) as { data: { id: string; slug: string } }).data;

		await page.goto(`/teams/${team.slug}/goals`);
		await waitForPageLoad(page);

		await page.getByRole('button', { name: 'New goal' }).click();
		await page.getByLabel('Title').fill('Launch public v1');
		await page.getByLabel('Description').fill('Ship the API to the public.');
		await page.getByLabel('Scope').selectOption({ label: 'Growth' });
		const goalsUrl = `/teams/${team.slug}/goals`;
		const { mutation: createResp } = await saveAndWaitForRefetch(
			page,
			page.getByRole('button', { name: 'Create' }),
			{
				mutation: (url, method) => url.pathname.endsWith(goalsUrl) && method === 'POST',
				refetch: (url, method) => url.pathname.endsWith(goalsUrl) && method === 'GET',
			},
		);
		expect(createResp.ok(), `POST /goals failed: ${await createResp.text()}`).toBe(true);

		await expect(page.getByRole('main').getByText('Launch public v1')).toBeVisible({
			timeout: 30000,
		});

		await page.goto(`/teams/${team.slug}/projects/${project.slug}/tasks`);
		await waitForPageLoad(page);
		await expect(
			page.getByRole('main').getByText('Review plans for goal: "Launch public v1"'),
		).toBeVisible({ timeout: 15000 });
	});
});
