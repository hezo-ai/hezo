import { test } from '@playwright/test';

test('debug — what does the wizard show?', async ({ page }) => {
	const errors: string[] = [];
	const messages: string[] = [];
	page.on('console', (msg) => {
		messages.push(`[${msg.type()}] ${msg.text()}`);
		if (msg.type() === 'error') errors.push(msg.text());
	});
	page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}\n${err.stack ?? ''}`));

	await page.goto('/');
	await page.waitForLoadState('networkidle');

	console.log('--- initial page url ---');
	console.log(await page.url());
	console.log('--- initial body text (first 500) ---');
	console.log((await page.locator('body').innerText()).slice(0, 500));

	// Set the master key via UI.
	const setKeyButton = page.getByRole('button', { name: /Set Key|Generate Key/ }).first();
	if (await setKeyButton.isVisible({ timeout: 3000 }).catch(() => false)) {
		await page.getByRole('button', { name: 'Generate Key' }).click();
		await page.getByRole('button', { name: /Set Key & Continue/ }).click();
		console.log('--- master key set ---');
	}

	await page.waitForLoadState('networkidle');
	await page.waitForTimeout(2000);

	console.log('--- after master key, url ---');
	console.log(await page.url());
	console.log('--- after master key, body text (first 1500) ---');
	console.log((await page.locator('body').innerText()).slice(0, 1500));
	console.log('--- after master key, body innerHTML length ---');
	console.log((await page.locator('body').innerHTML()).length);

	console.log('--- console errors ---');
	for (const e of errors) console.log(e);
	console.log('--- last 20 console messages ---');
	for (const m of messages.slice(-20)) console.log(m);

	await page.screenshot({ path: '/tmp/hezo-after-master-key.png', fullPage: true });
	console.log('screenshot saved to /tmp/hezo-after-master-key.png');
});
