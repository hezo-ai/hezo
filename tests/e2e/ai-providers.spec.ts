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
			await expect(moonshotCard.getByText('active')).toBeVisible({ timeout: 20000 });
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

		const [setDefaultResponse] = await Promise.all([
			page.waitForResponse(
				(resp) =>
					/\/api\/ai-providers\/.+\/default$/.test(resp.url()) &&
					resp.request().method() === 'PATCH',
			),
			anthropicCard.getByRole('button', { name: 'Set default' }).click(),
		]);
		expect(setDefaultResponse.ok()).toBe(true);

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
		await expect(page.getByText('Moonshot')).toBeVisible();

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
