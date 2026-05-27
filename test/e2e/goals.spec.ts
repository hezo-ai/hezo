import { expect, test } from './fixtures';
import {
	createProjectAndClearPlanning,
	saveAndWaitForRefetch,
	uniqueName,
	waitForPageLoad,
} from './helpers';

test.describe('Goals', () => {
	test('creates a team-wide goal from the Goals page and opens a Captain ticket', async ({
		sharedPage: page,
		sharedWorkspace,
	}) => {
		const { team, token } = sharedWorkspace;

		const projRes = await createProjectAndClearPlanning(page, team.id, token, {
			name: uniqueName('Goals Product'),
			description: 'Primary product workstream for goals e2e.',
		});
		expect(projRes.ok()).toBe(true);

		await page.goto(`/teams/${team.slug}/goals`);
		await waitForPageLoad(page);

		const goalTitle = uniqueName('Raise seed round');

		await page.getByRole('button', { name: 'New goal' }).click();

		await page.getByLabel('Title').fill(goalTitle);
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
		await expect(main.getByText(goalTitle)).toBeVisible({ timeout: 30000 });
		await expect(main.getByText('Team-wide').first()).toBeVisible();

		await page.goto(`/teams/${team.slug}/projects/internal/tasks`);
		await waitForPageLoad(page);
		await expect(
			page.getByRole('main').getByText(`Review plans for goal: "${goalTitle}"`),
		).toBeVisible({ timeout: 15000 });
	});

	test('project-scoped goal routes the Captain ticket into that project', async ({
		sharedPage: page,
		sharedWorkspace,
	}) => {
		const { team, token } = sharedWorkspace;
		const projectName = uniqueName('Growth');

		const projRes = await createProjectAndClearPlanning(page, team.id, token, {
			name: projectName,
			description: 'Growth engineering workstream.',
		});
		const project = ((await projRes.json()) as { data: { id: string; slug: string } }).data;

		await page.goto(`/teams/${team.slug}/goals`);
		await waitForPageLoad(page);

		const goalTitle = uniqueName('Launch public v1');

		await page.getByRole('button', { name: 'New goal' }).click();
		await page.getByLabel('Title').fill(goalTitle);
		await page.getByLabel('Description').fill('Ship the API to the public.');
		await page.getByLabel('Scope').selectOption({ label: projectName });
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

		await expect(page.getByRole('main').getByText(goalTitle)).toBeVisible({
			timeout: 30000,
		});

		await page.goto(`/teams/${team.slug}/projects/${project.slug}/tasks`);
		await waitForPageLoad(page);
		await expect(
			page.getByRole('main').getByText(`Review plans for goal: "${goalTitle}"`),
		).toBeVisible({ timeout: 15000 });
	});
});
