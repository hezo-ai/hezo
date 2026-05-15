import { expect, test } from './fixtures';
import { authenticate, createCompanyLight } from './helpers';

test('audit log page renders at the dedicated route', async ({ page }) => {
	await authenticate(page);
	const { company } = await createCompanyLight(page);

	await page.goto(`/companies/${company.id}/audit-log`);
	await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible({ timeout: 20000 });
});
