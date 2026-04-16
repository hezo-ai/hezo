import { expect, test } from '@playwright/test';
import { authenticate, getToken } from './helpers';

test.describe('AI Providers instance settings', () => {
	test('lists all four provider cards on /settings/ai-providers', async ({ page }) => {
		await authenticate(page);
		await page.goto('/settings/ai-providers');

		await expect(page.getByRole('heading', { name: 'AI providers' })).toBeVisible();
		await expect(page.getByText('Anthropic')).toBeVisible();
		await expect(page.getByText('OpenAI')).toBeVisible();
		await expect(page.getByText('Google')).toBeVisible();
		await expect(page.getByText('Moonshot')).toBeVisible();
	});

	test('can add a new provider key via the settings UI', async ({ page }) => {
		await authenticate(page);
		await page.goto('/settings/ai-providers');

		const moonshotCard = page
			.locator('div.border.border-border.rounded-radius-md.p-3', { hasText: 'Moonshot' })
			.first();

		const enterButton = moonshotCard.getByRole('button', { name: 'Enter API key' });
		if (await enterButton.isVisible().catch(() => false)) {
			await enterButton.click();
			await moonshotCard.locator('input[type="password"]').fill('sk-moonshot-e2e-test');
			await moonshotCard.getByRole('button', { name: 'Save' }).click();
			await expect(moonshotCard.getByText('active')).toBeVisible({ timeout: 10000 });
		}
	});
});

test.describe('AI Providers API (instance-scoped)', () => {
	test('status endpoint reflects add/delete cycle', async ({ page }) => {
		const token = await getToken(page);
		const headers = { Authorization: `Bearer ${token}` };

		const initialStatus = await page.request.get('/api/ai-providers/status', { headers });
		expect((await initialStatus.json()).data).toHaveProperty('configured');

		const listRes = await page.request.get('/api/ai-providers', { headers });
		const initialConfigs = (await listRes.json()).data as Array<{ id: string; provider: string }>;
		const hadGoogle = initialConfigs.some((c) => c.provider === 'google');
		if (hadGoogle) test.skip(true, 'Google already configured in this run');

		const createRes = await page.request.post('/api/ai-providers', {
			headers: { ...headers, 'Content-Type': 'application/json' },
			data: { provider: 'google', api_key: 'AIza-e2e-test', label: 'google-e2e' },
		});
		expect(createRes.status()).toBe(201);
		const configId = (await createRes.json()).data.id;

		const afterCreate = await page.request.get('/api/ai-providers/status', { headers });
		expect((await afterCreate.json()).data.providers).toContain('google');

		const deleteRes = await page.request.delete(`/api/ai-providers/${configId}`, { headers });
		expect(deleteRes.status()).toBe(200);
	});

	test('rejects invalid provider names', async ({ page }) => {
		const token = await getToken(page);
		const headers = { Authorization: `Bearer ${token}` };

		const res = await page.request.post('/api/ai-providers', {
			headers: { ...headers, 'Content-Type': 'application/json' },
			data: { provider: 'invalid', api_key: 'test' },
		});
		expect(res.status()).toBe(400);
	});

	test('validates API key format for anthropic', async ({ page }) => {
		const token = await getToken(page);
		const headers = { Authorization: `Bearer ${token}` };

		const res = await page.request.post('/api/ai-providers', {
			headers: { ...headers, 'Content-Type': 'application/json' },
			data: { provider: 'anthropic', api_key: 'wrong-prefix-key', label: 'bad-format' },
		});
		expect(res.status()).toBe(400);
		const body = await res.json();
		expect(body.error.code).toBe('INVALID_KEY_FORMAT');
	});
});
