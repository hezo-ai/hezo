// Decision-tree items 1-2: whether a delete confirmation fits a phone screen is
// real layout at a real viewport. happy-dom computes no widths, so a long
// unbroken name that pushes the dialog past the screen edge passes every
// component test.
import { expect, test } from './fixtures';

test('a delete confirmation naming a long item fits a phone screen', async ({
	authedPage: page,
	apiToken,
}) => {
	// One unbroken token, longer than a phone is wide: a key name, a file name or
	// a repository path can all look like this.
	const name = `revoke-${'x'.repeat(120)}-${Date.now()}`;
	const res = await page.request.post('/api/api-keys', {
		headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
		data: { name },
	});
	expect(res.status()).toBe(201);

	await page.goto('/settings/api-keys');
	const row = page.locator('tr').filter({ hasText: name });
	await row.getByRole('button', { name: 'Revoke' }).click();

	const dialog = page.getByRole('alertdialog');
	await expect(dialog).toBeVisible({ timeout: 15_000 });
	await expect(dialog.getByRole('heading')).toHaveText(`Revoke ${name}?`);

	// The name wraps: nothing in the dialog scrolls sideways.
	const sideways = await dialog.evaluate((el) => el.scrollWidth - el.clientWidth);
	expect(sideways).toBeLessThanOrEqual(0);

	const width = page.viewportSize()?.width ?? 0;
	for (const part of [
		dialog.getByRole('heading'),
		dialog.getByRole('button', { name: /Cancel/ }),
		dialog.getByTestId('confirm-dialog-confirm'),
	]) {
		const box = await part.boundingBox();
		expect(box).not.toBeNull();
		expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
		expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
	}

	// No line of the title runs under the close button.
	const titleUnderClose = await dialog.evaluate((el) => {
		const title = el.querySelector('h2');
		const close = el.querySelector('[data-testid="confirm-dialog-close"]');
		if (!title || !close) return true;
		const button = close.getBoundingClientRect();
		const range = document.createRange();
		range.selectNodeContents(title);
		return Array.from(range.getClientRects()).some(
			(line) => line.right > button.left && line.bottom > button.top && line.top < button.bottom,
		);
	});
	expect(titleUnderClose).toBe(false);

	await dialog.getByTestId('confirm-dialog-confirm').click();
	await expect(dialog).toBeHidden();
	await expect(page.locator('tr').filter({ hasText: name })).toHaveCount(0);
});
