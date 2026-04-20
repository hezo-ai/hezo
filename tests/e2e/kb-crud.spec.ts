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

test('kb empty state shows new document button', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company } = await createCompany(page);
	await page.goto(`/companies/${company.slug}/kb`);
	await expect(page.getByText('Loading...')).toBeHidden({ timeout: 15000 });

	await expect(page.getByRole('button', { name: 'New document' })).toBeVisible({ timeout: 5000 });
});

test('can create and view a kb document', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company } = await createCompany(page);
	await page.goto(`/companies/${company.slug}/kb`);
	await expect(page.getByText('Loading...')).toBeHidden({ timeout: 15000 });

	await page.getByRole('button', { name: 'New document' }).click();
	await page.getByLabel('Title').fill('Onboarding Guide');
	await page.locator('textarea').fill('# Welcome\n\nThis is a **test** document.');
	await page.getByRole('button', { name: 'Create' }).click();

	await expect(page.getByRole('heading', { name: 'Onboarding Guide' })).toBeVisible({
		timeout: 5000,
	});
	await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible({ timeout: 5000 });
	await expect(page.getByRole('button', { name: 'Edit' })).toBeVisible({ timeout: 5000 });
	await expect(page.getByRole('button', { name: /revision history/i })).toBeVisible({
		timeout: 5000,
	});
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

	await page.goto(`/companies/${company.slug}/kb?slug=${doc.slug}`);
	await expect(page.getByRole('heading', { name: 'Edit Me' })).toBeVisible({ timeout: 5000 });

	await page.getByRole('button', { name: 'Edit', exact: true }).click();
	await page.locator('textarea').fill('Updated content body');
	await page.getByRole('button', { name: 'Save' }).click();

	await expect(page.getByText('Updated content body')).toBeVisible({ timeout: 5000 });
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
	await expect(page.getByText('Loading...')).toBeHidden({ timeout: 10000 });

	await page.getByRole('button', { name: 'Delete Me' }).click();
	await expect(page.getByRole('button', { name: 'Edit' })).toBeVisible({ timeout: 5000 });

	page.on('dialog', (dialog) => dialog.accept());
	await page.getByRole('button', { name: 'Delete document' }).click();

	await expect(page.getByRole('button', { name: 'Delete Me' })).toBeHidden({ timeout: 5000 });
});
