import { expect, test } from './fixtures';
import { createProjectAndClearPlanning, uniqueName } from './helpers';

test('can create, view, edit, and delete a project document', async ({
	sharedPage: page,
	sharedWorkspace,
}) => {
	const { team, token } = sharedWorkspace;
	const project = await createProjectAndClearPlanning(page, team.id, token, {
		name: uniqueName('Docs Test Project'),
		description: 'Project for testing the documents tab.',
	});

	await page.goto(`/teams/${team.slug}/projects/${project.slug}/documents`);
	await expect(page.getByText('Loading...')).toBeHidden({ timeout: 15000 });

	const filename = `notes-${Math.random().toString(36).slice(2, 8)}.md`;
	await page.getByRole('button', { name: 'New document' }).click();
	await page.getByLabel('Filename').fill(filename);
	await page.locator('textarea').fill('# Project Notes\n\nSome **markdown** content.');
	await page.getByRole('button', { name: 'Create', exact: true }).click();

	await expect(page.getByRole('heading', { name: filename })).toBeVisible({ timeout: 15000 });
	await expect(page.getByRole('heading', { name: 'Project Notes' })).toBeVisible({
		timeout: 15000,
	});

	await page.getByRole('button', { name: 'Edit' }).click();
	await page.locator('textarea').fill('Updated content for the doc');
	await page.getByRole('button', { name: 'Save' }).click();

	await expect(page.getByText('Updated content for the doc')).toBeVisible({ timeout: 15000 });

	page.on('dialog', (dialog) => dialog.accept());
	await page.getByRole('button', { name: 'Delete document' }).click();

	await expect(page.getByRole('button', { name: filename })).toBeHidden({ timeout: 15000 });
});

test('shows revision history and restores a previous version', async ({
	sharedPage: page,
	sharedWorkspace,
}) => {
	const { team, token } = sharedWorkspace;
	const project = await createProjectAndClearPlanning(page, team.id, token, {
		name: uniqueName('Revision Project'),
		description: 'Project for testing project doc revisions.',
	});

	const filename = `plan-${Math.random().toString(36).slice(2, 8)}.md`;
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
	const docPath = `/api/teams/${team.id}/projects/${project.slug}/docs/${filename}`;
	const create = await page.request.put(docPath, { headers, data: { content: 'Original plan' } });
	expect(create.ok()).toBe(true);
	const update = await page.request.put(docPath, { headers, data: { content: 'Second draft' } });
	expect(update.ok()).toBe(true);

	await page.goto(`/teams/${team.slug}/projects/${project.slug}/documents?file=${filename}`);
	await expect(page.getByText('Loading...')).toBeHidden({ timeout: 15000 });
	await expect(page.getByText('Second draft')).toBeVisible({ timeout: 15000 });

	await page.getByRole('button', { name: /show revision history/i }).click();
	await expect(page.getByText(/Rev 1/)).toBeVisible({ timeout: 15000 });

	await page
		.getByRole('button', { name: /restore/i })
		.first()
		.click();
	const docRefetched = page.waitForResponse(
		(r) =>
			r.request().method() === 'GET' &&
			r.url().endsWith(`/projects/${project.slug}/docs/${filename}`),
		{ timeout: 30000 },
	);
	await page.getByTestId('confirm-dialog-confirm').click();
	await docRefetched;
	await expect(page.getByText('Original plan')).toBeVisible({ timeout: 15000 });
});

test('rejects invalid filename when creating a document', async ({
	sharedPage: page,
	sharedWorkspace,
}) => {
	const { team, token } = sharedWorkspace;
	const project = await createProjectAndClearPlanning(page, team.id, token, {
		name: uniqueName('Filename Test'),
		description: 'Tests filename validation.',
	});

	await page.goto(`/teams/${team.slug}/projects/${project.slug}/documents`);
	await expect(page.getByText('Loading...')).toBeHidden({ timeout: 15000 });

	await page.getByRole('button', { name: 'New document' }).click();
	await page.getByLabel('Filename').fill('not-markdown');
	await page.locator('textarea').fill('content');
	await page.getByRole('button', { name: 'Create', exact: true }).click();

	await expect(page.getByText(/Filename must end with \.md/)).toBeVisible({ timeout: 15000 });
});
