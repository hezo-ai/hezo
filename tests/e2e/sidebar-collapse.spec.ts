import { expect, test } from '@playwright/test';
import { authenticate, createCompanyWithAgents } from './helpers';

test('sidebar can be collapsed and the state persists across reload', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company } = await createCompanyWithAgents(page);
	await page.goto(`/companies/${company.slug}/inbox`);

	// Sidebar visible by default — Resources section header is in the CompanySidebar
	await expect(page.getByText('Resources').first()).toBeVisible({ timeout: 10000 });

	const toggle = page.getByTestId('sidebar-toggle');
	await expect(toggle).toBeVisible();
	await expect(toggle).toHaveAccessibleName('Collapse sidebar');

	await toggle.click();
	await expect(toggle).toHaveAccessibleName('Expand sidebar', { timeout: 5000 });
	await expect(page.getByText('Resources').first()).toBeHidden({ timeout: 5000 });

	await page.reload();
	await expect(page.getByTestId('sidebar-toggle')).toHaveAccessibleName('Expand sidebar', {
		timeout: 10000,
	});
	await expect(page.getByText('Resources').first()).toBeHidden({ timeout: 5000 });

	await page.getByTestId('sidebar-toggle').click();
	await expect(page.getByText('Resources').first()).toBeVisible({ timeout: 5000 });
});
