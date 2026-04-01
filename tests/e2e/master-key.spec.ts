import { expect, test } from '@playwright/test';

test('shows master key gate on first visit', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByText('Set Master Key')).toBeVisible();
});

test('can set master key and proceed', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByText('Set Master Key')).toBeVisible();

	await page.getByRole('button', { name: 'Generate Key' }).click();
	await page.getByRole('button', { name: 'Copy to clipboard' }).click();

	const keyInput = page.getByPlaceholder('Paste generated key to confirm');
	const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
	await keyInput.fill(clipboardText);

	await page.getByRole('button', { name: 'Set Key & Continue' }).click();
	await expect(page.getByText('Companies')).toBeVisible({ timeout: 10000 });
});
