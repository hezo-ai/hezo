import { expect, test } from '@playwright/test';
import { authenticate, getToken } from './helpers';

async function createCompany(page: import('@playwright/test').Page) {
	const token = await getToken(page);
	const headers = { Authorization: `Bearer ${token}` };

	const companyRes = await page.request.post('/api/companies', {
		headers,
		data: {
			name: `KB Test ${Date.now()}`,
			issue_prefix: `KB${Date.now().toString().slice(-4)}`,
		},
	});
	const company = (await companyRes.json()).data;
	return { company, token, headers };
}

test('kb list shows empty state and new document button', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company } = await createCompany(page);
	await page.goto(`/companies/${company.slug}/kb`);
	await expect(page.getByText('Loading...')).toBeHidden({ timeout: 15000 });

	await expect(page.getByText('No documents yet')).toBeVisible({ timeout: 5000 });
	await expect(page.getByRole('link', { name: 'New document' })).toBeVisible({ timeout: 5000 });
});

test('can create and view a kb document', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company } = await createCompany(page);
	await page.goto(`/companies/${company.slug}/kb/new`);

	await page.getByLabel('Title').fill('Onboarding Guide');
	await page.locator('textarea').fill('# Welcome\n\nThis is a **test** document.');
	await page.getByRole('button', { name: 'Create' }).click();

	await expect(page.getByText('Onboarding Guide')).toBeVisible({ timeout: 5000 });
	await expect(page.getByText('Welcome')).toBeVisible({ timeout: 5000 });
	await expect(page.getByRole('button', { name: 'Edit' })).toBeVisible({ timeout: 5000 });
	await expect(page.getByRole('button', { name: 'History' })).toBeVisible({ timeout: 5000 });
});

test('can edit a kb document', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company, headers } = await createCompany(page);

	const docRes = await page.request.post(`/api/companies/${company.id}/kb-docs`, {
		headers,
		data: { title: 'Edit Me', content: 'Original content' },
	});
	const doc = (await docRes.json()).data;

	await page.goto(`/companies/${company.slug}/kb/${doc.slug}`);
	await expect(page.getByText('Edit Me')).toBeVisible({ timeout: 5000 });

	// Click Edit link to navigate to edit page
	await page.getByRole('link', { name: 'Edit' }).click();
	await expect(page.getByLabel('Title')).toBeVisible({ timeout: 10000 });

	await page.getByLabel('Title').fill('Updated Title');
	await page.getByRole('button', { name: 'Save' }).click();

	await expect(page.getByText('Updated Title')).toBeVisible({ timeout: 5000 });
});

test('can delete a kb document', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company, headers } = await createCompany(page);

	await page.request.post(`/api/companies/${company.id}/kb-docs`, {
		headers,
		data: { title: 'Delete Me', content: 'Will be deleted' },
	});

	await page.goto(`/companies/${company.slug}/kb`);
	await expect(page.getByText('Delete Me')).toBeVisible({ timeout: 5000 });

	await page.getByText('Delete Me').click();
	await expect(page.getByRole('button', { name: 'Edit' })).toBeVisible({ timeout: 5000 });

	page.on('dialog', (dialog) => dialog.accept());
	await page.locator('button.text-accent-red').click();
	await expect(page.getByText('Loading...')).toBeHidden({ timeout: 10000 });

	await expect(page.getByText('No documents yet')).toBeVisible({ timeout: 5000 });
});
