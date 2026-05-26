import { expect, test } from '@playwright/test';
import { authenticate, createProjectAndClearPlanning, createTeamWithAgents } from './helpers';

test('can create, view, edit, and delete a project document', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { team, token } = await createTeamWithAgents(page);
	const project = await createProjectAndClearPlanning(page, team.id, token, {
		name: 'Docs Test Project',
		description: 'Project for testing the documents tab.',
	});

	await page.goto(`/teams/${team.slug}/projects/${project.slug}/documents`);
	await expect(page.getByText('Loading...')).toBeHidden({ timeout: 15000 });

	await page.getByRole('button', { name: 'New document' }).click();
	await page.getByLabel('Filename').fill('notes.md');
	await page.locator('textarea').fill('# Project Notes\n\nSome **markdown** content.');
	await page.getByRole('button', { name: 'Create', exact: true }).click();

	await expect(page.getByRole('heading', { name: 'notes.md' })).toBeVisible({ timeout: 15000 });
	await expect(page.getByRole('heading', { name: 'Project Notes' })).toBeVisible({
		timeout: 15000,
	});

	await page.getByRole('button', { name: 'Edit' }).click();
	await page.locator('textarea').fill('Updated content for the doc');
	await page.getByRole('button', { name: 'Save' }).click();

	await expect(page.getByText('Updated content for the doc')).toBeVisible({ timeout: 15000 });

	page.on('dialog', (dialog) => dialog.accept());
	await page.getByRole('button', { name: 'Delete document' }).click();

	await expect(page.getByRole('button', { name: 'notes.md' })).toBeHidden({ timeout: 15000 });
});

test('shows revision history and restores a previous version', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { team, token } = await createTeamWithAgents(page);
	const project = await createProjectAndClearPlanning(page, team.id, token, {
		name: 'Revision Project',
		description: 'Project for testing project doc revisions.',
	});

	// Seed the doc + a revision through the API so the test isn't racing the
	// UI's fire-and-forget mutation against background agent activity. The UI
	// path is already covered by the "create, view, edit, and delete" test
	// above; this test focuses on the revision-history viewer + restore flow.
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
	const docPath = `/api/teams/${team.id}/projects/${project.slug}/docs/plan.md`;
	const create = await page.request.put(docPath, { headers, data: { content: 'Original plan' } });
	expect(create.ok()).toBe(true);
	const update = await page.request.put(docPath, { headers, data: { content: 'Second draft' } });
	expect(update.ok()).toBe(true);

	await page.goto(`/teams/${team.slug}/projects/${project.slug}/documents?file=plan.md`);
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
			r.request().method() === 'GET' && r.url().endsWith(`/projects/${project.slug}/docs/plan.md`),
		{ timeout: 30000 },
	);
	await page.getByTestId('confirm-dialog-confirm').click();
	await docRefetched;
	await expect(page.getByText('Original plan')).toBeVisible({ timeout: 15000 });
});

test('rejects invalid filename when creating a document', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { team, token } = await createTeamWithAgents(page);
	const project = await createProjectAndClearPlanning(page, team.id, token, {
		name: 'Filename Test',
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
