import { expect, test } from '@playwright/test';
import { authenticate, createCompanyWithAgents, createProjectAndClearPlanning } from './helpers';

test('can create, view, edit, and delete a project document', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company, token } = await createCompanyWithAgents(page);
	const project = await createProjectAndClearPlanning(page, company.id, token, {
		name: 'Docs Test Project',
		description: 'Project for testing the documents tab.',
	});

	await page.goto(`/companies/${company.slug}/projects/${project.slug}/documents`);
	await expect(page.getByText('Loading...')).toBeHidden({ timeout: 15000 });

	await page.getByRole('button', { name: 'New document' }).click();
	await page.getByLabel('Filename').fill('notes.md');
	await page.locator('textarea').fill('# Project Notes\n\nSome **markdown** content.');
	await page.getByRole('button', { name: 'Create' }).click();

	await expect(page.getByRole('heading', { name: 'notes.md' })).toBeVisible({ timeout: 5000 });
	await expect(page.getByRole('heading', { name: 'Project Notes' })).toBeVisible({
		timeout: 5000,
	});

	await page.getByRole('button', { name: 'Edit' }).click();
	await page.locator('textarea').fill('Updated content for the doc');
	await page.getByRole('button', { name: 'Save' }).click();

	await expect(page.getByText('Updated content for the doc')).toBeVisible({ timeout: 5000 });

	page.on('dialog', (dialog) => dialog.accept());
	await page.getByRole('button', { name: 'Delete document' }).click();

	await expect(page.getByRole('button', { name: 'notes.md' })).toBeHidden({ timeout: 5000 });
});

test('shows revision history and restores a previous version', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company, token } = await createCompanyWithAgents(page);
	const project = await createProjectAndClearPlanning(page, company.id, token, {
		name: 'Revision Project',
		description: 'Project for testing project doc revisions.',
	});

	await page.goto(`/companies/${company.slug}/projects/${project.slug}/documents`);
	await expect(page.getByText('Loading...')).toBeHidden({ timeout: 15000 });

	await page.getByRole('button', { name: 'New document' }).click();
	await page.getByLabel('Filename').fill('plan.md');
	await page.locator('textarea').fill('Original plan');
	await page.getByRole('button', { name: 'Create' }).click();
	await expect(page.getByRole('heading', { name: 'plan.md' })).toBeVisible({ timeout: 5000 });

	await page.getByRole('button', { name: 'Edit' }).click();
	await page.locator('textarea').fill('Second draft');
	await page.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByText('Second draft')).toBeVisible({ timeout: 5000 });

	await page.getByRole('button', { name: /show revision history/i }).click();
	await expect(page.getByText(/Rev 1/)).toBeVisible({ timeout: 5000 });

	page.on('dialog', (dialog) => dialog.accept());
	await page
		.getByRole('button', { name: /restore/i })
		.first()
		.click();
	await expect(page.getByText('Original plan')).toBeVisible({ timeout: 5000 });
});

test('rejects invalid filename when creating a document', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company, token } = await createCompanyWithAgents(page);
	const project = await createProjectAndClearPlanning(page, company.id, token, {
		name: 'Filename Test',
		description: 'Tests filename validation.',
	});

	await page.goto(`/companies/${company.slug}/projects/${project.slug}/documents`);
	await expect(page.getByText('Loading...')).toBeHidden({ timeout: 15000 });

	await page.getByRole('button', { name: 'New document' }).click();
	await page.getByLabel('Filename').fill('not-markdown');
	await page.locator('textarea').fill('content');
	await page.getByRole('button', { name: 'Create' }).click();

	await expect(page.getByText(/Filename must end with \.md/)).toBeVisible({ timeout: 5000 });
});
