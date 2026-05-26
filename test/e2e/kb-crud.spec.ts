import { expect, test } from '@playwright/test';
import { authenticate, getToken } from './helpers';

async function createTeam(page: import('@playwright/test').Page) {
	const token = await getToken(page);
	const headers = { Authorization: `Bearer ${token}` };

	const teamRes = await page.request.post('/api/teams', {
		headers,
		data: {
			name: `KB Test ${Date.now()}`,
		},
	});
	const team = (await teamRes.json()).data;
	return { team, token, headers };
}

test('kb empty state shows new document button', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { team } = await createTeam(page);
	await page.goto(`/teams/${team.slug}/kb`);
	await expect(page.getByText('Loading...')).toBeHidden({ timeout: 15000 });

	await expect(page.getByRole('button', { name: 'New document' })).toBeVisible({ timeout: 15000 });
});

test('can create and view a kb document', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { team } = await createTeam(page);
	await page.goto(`/teams/${team.slug}/kb`);
	await expect(page.getByText('Loading...')).toBeHidden({ timeout: 15000 });

	await page.getByRole('button', { name: 'New document' }).click();
	await page.getByLabel('Title').fill('Onboarding Guide');
	await page.locator('textarea').fill('# Welcome\n\nThis is a **test** document.');
	await page.getByRole('button', { name: 'Create', exact: true }).click();

	await expect(page.getByRole('heading', { name: 'Onboarding Guide' })).toBeVisible({
		timeout: 15000,
	});
	await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible({ timeout: 15000 });
	await expect(page.getByRole('button', { name: 'Edit' })).toBeVisible({ timeout: 15000 });
	await expect(page.getByRole('button', { name: /revision history/i })).toBeVisible({
		timeout: 15000,
	});
});

test('can edit a kb document', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { team, headers } = await createTeam(page);

	const docRes = await page.request.post(`/api/teams/${team.id}/kb-docs`, {
		headers,
		data: { title: 'Edit Me', content: 'Original content' },
	});
	const doc = (await docRes.json()).data;

	await page.goto(`/teams/${team.slug}/kb?slug=${doc.slug}`);
	await expect(page.getByRole('heading', { name: 'Edit Me' })).toBeVisible({ timeout: 15000 });

	await page.getByRole('button', { name: 'Edit', exact: true }).click();
	await page.locator('textarea').fill('Updated content body');
	await page.getByRole('button', { name: 'Save' }).click();

	await expect(page.getByText('Updated content body')).toBeVisible({ timeout: 15000 });
});

test('shows revision history and restores a previous version', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { team, headers } = await createTeam(page);

	const docRes = await page.request.post(`/api/teams/${team.id}/kb-docs`, {
		headers,
		data: { title: 'Restore Me', content: 'Original kb body' },
	});
	const doc = (await docRes.json()).data;

	await page.request.patch(`/api/teams/${team.id}/kb-docs/${doc.slug}`, {
		headers,
		data: { content: 'Updated kb body', change_summary: 'second pass' },
	});

	await page.goto(`/teams/${team.slug}/kb?slug=${doc.slug}`);
	await expect(page.getByText('Updated kb body')).toBeVisible({ timeout: 15000 });

	await page.getByRole('button', { name: /show revision history/i }).click();
	await expect(page.getByText(/Rev 1/)).toBeVisible({ timeout: 15000 });

	await page.getByRole('button', { name: 'Restore', exact: true }).click();
	const kbDocRefetched = page.waitForResponse(
		(r) => r.request().method() === 'GET' && r.url().endsWith(`/kb-docs/${doc.slug}`),
		{ timeout: 30000 },
	);
	await page.getByTestId('confirm-dialog-confirm').click();
	await kbDocRefetched;
	await expect(page.getByText('Original kb body')).toBeVisible({ timeout: 15000 });
});

test('can delete a kb document', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { team, headers } = await createTeam(page);

	await page.request.post(`/api/teams/${team.id}/kb-docs`, {
		headers,
		data: { title: 'Delete Me', content: 'Will be deleted' },
	});

	await page.goto(`/teams/${team.slug}/kb`);
	await expect(page.getByText('Loading...')).toBeHidden({ timeout: 20000 });

	await page.getByRole('button', { name: 'Delete Me' }).click();
	await expect(page.getByRole('button', { name: 'Edit' })).toBeVisible({ timeout: 15000 });

	page.on('dialog', (dialog) => dialog.accept());
	await page.getByRole('button', { name: 'Delete document' }).click();

	await expect(page.getByRole('button', { name: 'Delete Me' })).toBeHidden({ timeout: 15000 });
});
