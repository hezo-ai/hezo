import { expect, test } from '@playwright/test';
import { authenticate, clearAiProviders, getToken, waitForPageLoad } from './helpers';

test.describe('AI Providers instance settings', () => {
	test('lists all three provider cards on /settings/ai-providers', async ({ page }) => {
		await authenticate(page);
		await page.goto('/settings/ai-providers');

		await expect(page.getByRole('heading', { name: 'AI providers' })).toBeVisible();
		await expect(page.getByText('Anthropic')).toBeVisible();
		await expect(page.getByText('OpenAI')).toBeVisible();
		await expect(page.getByText('Google')).toBeVisible();
		await expect(page.getByText('Moonshot')).toHaveCount(0);
		await expect(page.getByRole('button', { name: /OAuth/i })).toHaveCount(0);
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

	test('can add an Anthropic API key via the settings UI', async ({ page }) => {
		const token = await getToken(page);
		await clearAiProviders(page, token);

		await authenticate(page);
		await page.goto('/settings/ai-providers');

		const anthropicCard = page
			.locator('div.border.border-border.rounded-radius-md.p-3', { hasText: 'Anthropic' })
			.first();

		await anthropicCard.getByRole('button', { name: 'Enter API key' }).click();
		await anthropicCard.locator('input[type="password"]').fill('sk-ant-e2e-test-1234567890');
		await anthropicCard.getByRole('button', { name: 'Save' }).click();
		await expect(anthropicCard.getByText('active')).toBeVisible({ timeout: 20000 });

		await clearAiProviders(page, token);
	});

	test('does not offer subscription auth for Anthropic', async ({ page }) => {
		await authenticate(page);
		await page.goto('/settings/ai-providers');

		const anthropicCard = page
			.locator('div.border.border-border.rounded-radius-md.p-3', { hasText: 'Anthropic' })
			.first();

		await expect(anthropicCard.getByRole('button', { name: /Enter API key/i })).toBeVisible();
		await expect(
			anthropicCard.getByRole('button', { name: /Use Claude Code subscription/i }),
		).toHaveCount(0);
	});

	test('offers ChatGPT subscription paste flow for OpenAI', async ({ page }) => {
		const token = await getToken(page);
		await clearAiProviders(page, token);

		await authenticate(page);
		await page.goto('/settings/ai-providers');

		const openaiCard = page
			.locator('div.border.border-border.rounded-radius-md.p-3', { hasText: 'OpenAI' })
			.first();

		await openaiCard.getByRole('button', { name: /Use Codex subscription/i }).click();
		await expect(openaiCard.getByText(/codex login/i).first()).toBeVisible();
		await openaiCard
			.locator('textarea')
			.fill(JSON.stringify({ tokens: { refresh_token: 'rt-e2e-paste' } }));
		await openaiCard.getByRole('button', { name: 'Save' }).click();

		await expect(openaiCard.getByText('Subscription', { exact: true })).toBeVisible({
			timeout: 20000,
		});

		await clearAiProviders(page, token);
	});

	test('offers Gemini subscription paste flow for Google', async ({ page }) => {
		const token = await getToken(page);
		await clearAiProviders(page, token);

		await authenticate(page);
		await page.goto('/settings/ai-providers');

		const googleCard = page
			.locator('div.border.border-border.rounded-radius-md.p-3', { hasText: 'Google' })
			.first();

		await googleCard.getByRole('button', { name: /Use Gemini subscription/i }).click();
		await expect(googleCard.getByText(/oauth_creds\.json/i).first()).toBeVisible();
		await googleCard.locator('textarea').fill(
			JSON.stringify({
				access_token: 'ya29.test',
				refresh_token: '1//0g-rt-e2e',
				token_type: 'Bearer',
				scope: 'https://www.googleapis.com/auth/generative-language',
				expiry_date: 1745780000000,
			}),
		);
		await googleCard.getByRole('button', { name: 'Save' }).click();

		await expect(googleCard.getByText('Subscription', { exact: true })).toBeVisible({
			timeout: 20000,
		});

		await clearAiProviders(page, token);
	});

	test('renders API key + Subscription side-by-side and can flip the default', async ({ page }) => {
		const token = await getToken(page);
		const headers = { Authorization: `Bearer ${token}` };

		await clearAiProviders(page, token);

		const apiRes = await page.request.post('/api/ai-providers', {
			headers: { ...headers, 'Content-Type': 'application/json' },
			data: {
				provider: 'openai',
				api_key: 'sk-mix-test',
				label: 'openai-mix-api',
				auth_method: 'api_key',
			},
		});
		expect(apiRes.status()).toBe(201);

		const subscriptionRes = await page.request.post('/api/ai-providers', {
			headers: { ...headers, 'Content-Type': 'application/json' },
			data: {
				provider: 'openai',
				api_key: JSON.stringify({ tokens: { refresh_token: 'rt-mix' } }),
				label: 'openai-mix-subscription',
				auth_method: 'subscription',
			},
		});
		expect(subscriptionRes.status()).toBe(201);

		await authenticate(page);
		await page.goto('/settings/ai-providers');

		const openaiCard = page
			.locator('div.border.border-border.rounded-radius-md.p-3', { hasText: 'OpenAI' })
			.first();

		await expect(openaiCard.getByText('API Key', { exact: true })).toBeVisible();
		await expect(openaiCard.getByText('Subscription', { exact: true })).toBeVisible();
		await expect(openaiCard.getByText('Default', { exact: true })).toBeVisible();
		await expect(openaiCard.getByRole('button', { name: /Use Codex subscription/i })).toHaveCount(
			0,
		);
		await expect(openaiCard.getByRole('button', { name: 'Enter API key' })).toHaveCount(0);

		const [setDefaultResponse] = await Promise.all([
			page.waitForResponse(
				(resp) =>
					/\/api\/ai-providers\/.+\/default$/.test(resp.url()) &&
					resp.request().method() === 'PATCH',
			),
			openaiCard.getByRole('button', { name: 'Set default' }).click(),
		]);
		expect(setDefaultResponse.ok()).toBe(true);

		const listAfter = await page.request.get('/api/ai-providers', { headers });
		const configs = (await listAfter.json()).data as Array<{
			id: string;
			auth_method: string;
			is_default: boolean;
			provider: string;
		}>;
		const defaultConfig = configs.find((c) => c.is_default && c.provider === 'openai');
		expect(defaultConfig?.auth_method).toBe('subscription');

		await clearAiProviders(page, token);
	});
});

test.describe('AI provider gate (post-master-key, pre-company)', () => {
	test('blocks the app when no provider is configured and drops once one is added', async ({
		page,
	}) => {
		const token = await getToken(page);
		await clearAiProviders(page, token);

		await page.addInitScript((t: string) => {
			localStorage.setItem('hezo_token', t);
		}, token);

		await page.goto('/');

		await expect(page.getByRole('heading', { name: 'Set up an AI provider' })).toBeVisible({
			timeout: 20000,
		});
		await expect(page.getByText('Anthropic')).toBeVisible();
		await expect(page.getByText('OpenAI')).toBeVisible();
		await expect(page.getByText('Google')).toBeVisible();
		await expect(page.getByText('Moonshot')).toHaveCount(0);

		await expect(page.getByRole('heading', { name: 'Welcome to Hezo' })).toBeHidden();

		await page.getByRole('button', { name: 'Enter API key' }).first().click();
		await page.locator('input[type="password"]').first().fill('sk-ant-gate-test-12345');
		await page.getByRole('button', { name: 'Save' }).first().click();

		await expect(page.getByRole('heading', { name: 'Set up an AI provider' })).toBeHidden({
			timeout: 20000,
		});
		await expect(page).toHaveURL(/\/companies(\/|$)/);
	});

	test('re-raises the gate after deleting the last provider', async ({ page }) => {
		const token = await getToken(page);
		const headers = { Authorization: `Bearer ${token}` };
		const statusRes = await page.request.get('/api/ai-providers/status', { headers });
		if (!(await statusRes.json()).data.configured) {
			await page.request.post('/api/ai-providers', {
				headers: { ...headers, 'Content-Type': 'application/json' },
				data: {
					provider: 'anthropic',
					api_key: 'sk-ant-gate-rerace',
					label: 'gate-rerace',
				},
			});
		}

		await page.addInitScript((t: string) => {
			localStorage.setItem('hezo_token', t);
		}, token);

		await page.goto('/settings/ai-providers');
		await expect(page.getByRole('heading', { name: 'AI providers' })).toBeVisible();

		await clearAiProviders(page, token);
		await page.reload();

		await expect(page.getByRole('heading', { name: 'Set up an AI provider' })).toBeVisible({
			timeout: 20000,
		});
	});
});
