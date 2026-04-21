import { expect, test } from '@playwright/test';
import { authenticate, clearAiProviders, getToken, waitForPageLoad } from './helpers';

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

	test('rail Settings icon opens global settings with AI providers section', async ({ page }) => {
		await authenticate(page);
		await page.goto('/companies');
		await waitForPageLoad(page);

		await page.getByTitle('Settings').click();
		await expect(page).toHaveURL(/\/settings\/?$/);
		await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
		await expect(page.getByRole('heading', { name: 'AI providers' })).toBeVisible();
		await expect(page.getByText('Anthropic')).toBeVisible();
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

	test('shows Connect via OAuth when API key is already configured', async ({ page }) => {
		await authenticate(page);
		await page.goto('/settings/ai-providers');

		const anthropicCard = page
			.locator('div.border.border-border.rounded-radius-md.p-3', { hasText: 'Anthropic' })
			.first();

		await expect(anthropicCard.getByText('API Key')).toBeVisible();
		await expect(anthropicCard.getByRole('button', { name: /Connect via OAuth/i })).toBeVisible();
		await expect(anthropicCard.getByRole('button', { name: 'Enter API key' })).toHaveCount(0);
	});

	test('renders API key + OAuth side-by-side and can flip the default', async ({ page }) => {
		const token = await getToken(page);
		const headers = { Authorization: `Bearer ${token}` };

		await clearAiProviders(page, token);

		const apiRes = await page.request.post('/api/ai-providers', {
			headers: { ...headers, 'Content-Type': 'application/json' },
			data: {
				provider: 'anthropic',
				api_key: 'sk-ant-mix-test',
				label: 'anthropic-mix-api',
				auth_method: 'api_key',
			},
		});
		expect(apiRes.status()).toBe(201);

		const oauthRes = await page.request.post('/api/ai-providers', {
			headers: { ...headers, 'Content-Type': 'application/json' },
			data: {
				provider: 'anthropic',
				api_key: 'oauth-mix-token',
				label: 'anthropic-mix-oauth',
				auth_method: 'oauth_token',
			},
		});
		expect(oauthRes.status()).toBe(201);

		await authenticate(page);
		await page.goto('/settings/ai-providers');

		const anthropicCard = page
			.locator('div.border.border-border.rounded-radius-md.p-3', { hasText: 'Anthropic' })
			.first();

		await expect(anthropicCard.getByText('API Key', { exact: true })).toBeVisible();
		await expect(anthropicCard.getByText('OAuth', { exact: true })).toBeVisible();
		await expect(anthropicCard.getByText('Default', { exact: true })).toBeVisible();
		await expect(anthropicCard.getByRole('button', { name: /Connect via OAuth/i })).toHaveCount(0);
		await expect(anthropicCard.getByRole('button', { name: 'Enter API key' })).toHaveCount(0);

		await anthropicCard.getByRole('button', { name: 'Set default' }).click();

		const listAfter = await page.request.get('/api/ai-providers', { headers });
		const configs = (await listAfter.json()).data as Array<{
			id: string;
			auth_method: string;
			is_default: boolean;
		}>;
		const defaultConfig = configs.find((c) => c.is_default);
		expect(defaultConfig?.auth_method).toBe('oauth_token');

		await clearAiProviders(page, token);
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

	test('allows an OAuth token config alongside an existing API key for the same provider', async ({
		page,
	}) => {
		const token = await getToken(page);
		const headers = { Authorization: `Bearer ${token}` };

		await clearAiProviders(page, token);

		const apiRes = await page.request.post('/api/ai-providers', {
			headers: { ...headers, 'Content-Type': 'application/json' },
			data: {
				provider: 'anthropic',
				api_key: 'sk-ant-coexist-api',
				label: 'anthropic-coexist-api',
				auth_method: 'api_key',
			},
		});
		expect(apiRes.status()).toBe(201);

		const oauthRes = await page.request.post('/api/ai-providers', {
			headers: { ...headers, 'Content-Type': 'application/json' },
			data: {
				provider: 'anthropic',
				api_key: 'oauth-coexist-token',
				label: 'anthropic-coexist-oauth',
				auth_method: 'oauth_token',
			},
		});
		expect(oauthRes.status()).toBe(201);

		const listRes = await page.request.get('/api/ai-providers', { headers });
		const rows = (await listRes.json()).data as Array<{ provider: string; auth_method: string }>;
		const anthropic = rows.filter((r) => r.provider === 'anthropic');
		expect(anthropic.length).toBe(2);
		expect(anthropic.some((r) => r.auth_method === 'api_key')).toBe(true);
		expect(anthropic.some((r) => r.auth_method === 'oauth_token')).toBe(true);

		await clearAiProviders(page, token);
	});

	test('PATCH default_model round-trip', async ({ page }) => {
		const token = await getToken(page);
		const headers = { Authorization: `Bearer ${token}` };

		await clearAiProviders(page, token);

		const create = await page.request.post('/api/ai-providers', {
			headers: { ...headers, 'Content-Type': 'application/json' },
			data: { provider: 'anthropic', api_key: 'sk-ant-dm-e2e', label: 'dm-e2e' },
		});
		expect(create.status()).toBe(201);
		const configId = (await create.json()).data.id;

		const patch = await page.request.patch(`/api/ai-providers/${configId}`, {
			headers: { ...headers, 'Content-Type': 'application/json' },
			data: { default_model: 'claude-opus-4-7' },
		});
		expect(patch.status()).toBe(200);

		const list = await page.request.get('/api/ai-providers', { headers });
		const row = (
			(await list.json()).data as Array<{ id: string; default_model: string | null }>
		).find((r) => r.id === configId);
		expect(row?.default_model).toBe('claude-opus-4-7');

		await clearAiProviders(page, token);
	});
});
