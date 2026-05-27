import { expect, test } from './fixtures';
import { createProjectAndClearPlanning, uniqueName, waitForPageLoad } from './helpers';

test.describe('Project CRUD', () => {
	test('creates a project via dialog and opens a Captain intake ticket in Internal', async ({
		sharedPage: page,
		sharedWorkspace,
	}) => {
		const { team } = sharedWorkspace;
		const name = uniqueName('Marketing Campaign');

		await page.goto(`/teams/${team.slug}/projects`);
		await waitForPageLoad(page);

		await page.getByRole('main').getByRole('button', { name: 'New project' }).click();

		await page.getByLabel('Name').fill(name);
		await page
			.getByLabel('Description')
			.fill('Q3 brand push aimed at existing users to drive upsells.');

		await page.getByRole('button', { name: 'Create' }).click();

		await expect(
			page,
			'expected navigation to the Internal-project intake task after submitting Create Project',
		).toHaveURL(new RegExp(`/teams/${team.slug}/projects/internal/tasks/[a-z0-9-]+(?:#.*)?$`), {
			timeout: 15000,
		});
		await expect(page.getByRole('main').getByText(`Open new project: ${name}`)).toBeVisible({
			timeout: 15000,
		});
		await expect(page.getByText("I'm the Captain")).toBeVisible({ timeout: 15000 });
		await expect(page.getByTestId('project-intake-skip')).toBeVisible({ timeout: 15000 });
	});

	test('project list shows default (Internal) project', async ({
		sharedPage: page,
		sharedWorkspace,
	}) => {
		const { team } = sharedWorkspace;

		await page.goto(`/teams/${team.slug}/projects`);
		await waitForPageLoad(page);

		await expect(page.getByRole('heading', { name: '(Internal)' })).toBeVisible({ timeout: 15000 });
	});

	test('project list shows task and repo counts', async ({ sharedPage: page, sharedWorkspace }) => {
		const { team, token } = sharedWorkspace;
		const name = uniqueName('Count Test');

		await createProjectAndClearPlanning(page, team.id, token, {
			name,
			description: 'Count test project.',
		});

		await page.goto(`/teams/${team.slug}/projects`);
		await waitForPageLoad(page);

		const card = page.getByRole('main').locator('a', { hasText: name });
		await expect(card).toBeVisible({ timeout: 15000 });
		await expect(card.getByText('0 tasks')).toBeVisible();
		await expect(card.getByText('0 repos')).toBeVisible();
	});

	test('project card links to project detail', async ({ sharedPage: page, sharedWorkspace }) => {
		const { team, token } = sharedWorkspace;
		const name = uniqueName('Linkable Project');

		const project = await createProjectAndClearPlanning(page, team.id, token, {
			name,
			description: 'Linkable project description.',
		});

		await page.goto(`/teams/${team.slug}/projects`);
		await waitForPageLoad(page);

		await page.getByRole('main').getByRole('heading', { name }).click();

		await expect(page).toHaveURL(new RegExp(`/teams/${team.slug}/projects/${project.slug}`), {
			timeout: 15000,
		});
	});

	test('creates a project with initial PRD and saves it as project doc', async ({
		sharedPage: page,
		sharedWorkspace,
	}) => {
		const { team, token } = sharedWorkspace;
		const headers = { Authorization: `Bearer ${token}` };

		const prdContent = '# Widget App\n\nA tool for managing widgets efficiently.';

		const project = await createProjectAndClearPlanning(page, team.id, token, {
			name: uniqueName('PRD Test Project'),
			description: 'Testing initial PRD upload.',
			initial_prd: prdContent,
		});

		const docRes = await page.request.get(
			`/api/teams/${team.id}/projects/${project.id}/docs/initial-prd.md`,
			{ headers },
		);
		expect(docRes.ok()).toBe(true);
		const doc = ((await docRes.json()) as any).data;
		expect(doc.content).toBe(prdContent);
		expect(doc.filename).toBe('initial-prd.md');
	});

	test('create button is disabled without name', async ({ sharedPage: page, sharedWorkspace }) => {
		const { team } = sharedWorkspace;

		await page.goto(`/teams/${team.slug}/projects`);
		await waitForPageLoad(page);

		await page.getByRole('main').getByRole('button', { name: 'New project' }).click();

		const createBtn = page.getByRole('button', { name: 'Create' });
		await expect(createBtn).toBeDisabled();

		await page.getByLabel('Name').fill('My Project');
		await expect(createBtn).toBeDisabled();

		await page.getByLabel('Description').fill('A short project description.');
		await expect(createBtn).toBeEnabled();
	});
});
