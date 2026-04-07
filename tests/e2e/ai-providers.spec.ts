import { expect, test } from '@playwright/test';
import { authenticate, getToken } from './helpers';

async function createCompany(page: import('@playwright/test').Page) {
	const token = await getToken(page);
	const headers = { Authorization: `Bearer ${token}` };

	const companyRes = await page.request.post('/api/companies', {
		headers,
		data: {
			name: `AI Provider Co ${Date.now()}`,
			issue_prefix: `AP${Date.now().toString().slice(-4)}`,
		},
	});
	const company = (await companyRes.json()).data;
	return { company, token, headers };
}

test.describe('Blocking setup modal', () => {
	test('shows modal when no AI providers configured', async ({ page }) => {
		await page.goto('/');
		await authenticate(page);

		const { company } = await createCompany(page);
		await page.goto(`/companies/${company.slug}`);

		// Blocking modal should appear
		const modal = page.getByText('Set up an AI provider');
		await expect(modal).toBeVisible({ timeout: 10000 });

		// Should show all 4 provider cards
		await expect(page.getByText('Anthropic')).toBeVisible();
		await expect(page.getByText('OpenAI')).toBeVisible();
		await expect(page.getByText('Google')).toBeVisible();
		await expect(page.getByText('Moonshot')).toBeVisible();
	});

	test('modal closes after adding an API key', async ({ page }) => {
		await page.goto('/');
		await authenticate(page);

		const { company } = await createCompany(page);
		await page.goto(`/companies/${company.slug}`);

		// Wait for modal
		await expect(page.getByText('Set up an AI provider')).toBeVisible({ timeout: 10000 });

		// Click "Enter API key" on Anthropic card
		const anthropicCard = page.locator('div').filter({ hasText: 'Anthropic' }).first();
		await anthropicCard.getByRole('button', { name: 'Enter API key' }).click();

		// Fill in the API key form
		await anthropicCard.locator('input[type="password"]').fill('sk-ant-test-key-12345');
		await anthropicCard.getByRole('button', { name: 'Save' }).click();

		// Modal should close
		await expect(page.getByText('Set up an AI provider')).toBeHidden({ timeout: 10000 });
	});

	test('modal does not appear when provider already configured', async ({ page }) => {
		await page.goto('/');
		await authenticate(page);

		const { company, headers } = await createCompany(page);

		// Add a provider via API before navigating
		await page.request.post(`/api/companies/${company.id}/ai-providers`, {
			headers: { ...headers, 'Content-Type': 'application/json' },
			data: {
				provider: 'anthropic',
				api_key: 'sk-ant-test-key-12345',
				label: 'Pre-configured',
			},
		});

		await page.goto(`/companies/${company.slug}`);

		// Modal should NOT appear
		await expect(page.getByText('Set up an AI provider')).toBeHidden({ timeout: 5000 });
	});
});

test.describe('AI Providers settings section', () => {
	test('displays AI providers section with all 4 providers', async ({ page }) => {
		await page.goto('/');
		await authenticate(page);

		const { company, headers } = await createCompany(page);

		// Pre-configure so modal doesn't block
		await page.request.post(`/api/companies/${company.id}/ai-providers`, {
			headers: { ...headers, 'Content-Type': 'application/json' },
			data: { provider: 'moonshot', api_key: 'sk-moonshot-test' },
		});

		await page.goto(`/companies/${company.slug}/settings`);

		const section = page.locator('#settings-ai-providers');
		await expect(section.getByText('AI providers')).toBeVisible({ timeout: 5000 });

		// Should show all 4 providers
		await expect(section.getByText('Anthropic')).toBeVisible();
		await expect(section.getByText('OpenAI')).toBeVisible();
		await expect(section.getByText('Google')).toBeVisible();
		await expect(section.getByText('Moonshot')).toBeVisible();
	});

	test('can add and remove an API key via settings', async ({ page }) => {
		await page.goto('/');
		await authenticate(page);

		const { company, headers } = await createCompany(page);

		// Pre-configure moonshot so modal doesn't block
		await page.request.post(`/api/companies/${company.id}/ai-providers`, {
			headers: { ...headers, 'Content-Type': 'application/json' },
			data: { provider: 'moonshot', api_key: 'sk-moonshot-test' },
		});

		await page.goto(`/companies/${company.slug}/settings`);

		const section = page.locator('#settings-ai-providers');
		await expect(section.getByText('AI providers')).toBeVisible({ timeout: 5000 });

		// Add an OpenAI key via the settings section
		const openaiCard = section.locator('div').filter({ hasText: 'OpenAI' }).first();
		await openaiCard.getByRole('button', { name: 'Enter API key' }).click();
		await openaiCard.locator('input[type="password"]').fill('sk-openai-test-key-12345');
		await openaiCard.getByRole('button', { name: 'Save' }).click();

		// Should show as configured with Active badge
		await expect(section.getByText('active')).toBeVisible({ timeout: 5000 });

		// Remove it
		await section.getByRole('button', { name: 'Remove' }).first().click();
	});
});

test.describe('AI Providers API', () => {
	test('status endpoint returns correct state', async ({ page }) => {
		await page.goto('/');
		await authenticate(page);

		const { company, headers } = await createCompany(page);

		// Initially no providers
		const statusRes1 = await page.request.get(`/api/companies/${company.id}/ai-providers/status`, {
			headers,
		});
		const status1 = (await statusRes1.json()).data;
		expect(status1.configured).toBe(false);
		expect(status1.providers).toEqual([]);

		// Add a provider
		await page.request.post(`/api/companies/${company.id}/ai-providers`, {
			headers: { ...headers, 'Content-Type': 'application/json' },
			data: { provider: 'anthropic', api_key: 'sk-ant-test-key' },
		});

		// Now should be configured
		const statusRes2 = await page.request.get(`/api/companies/${company.id}/ai-providers/status`, {
			headers,
		});
		const status2 = (await statusRes2.json()).data;
		expect(status2.configured).toBe(true);
		expect(status2.providers).toContain('anthropic');
	});

	test('rejects invalid provider names', async ({ page }) => {
		await page.goto('/');
		await authenticate(page);

		const { company, headers } = await createCompany(page);

		const res = await page.request.post(`/api/companies/${company.id}/ai-providers`, {
			headers: { ...headers, 'Content-Type': 'application/json' },
			data: { provider: 'invalid', api_key: 'test' },
		});
		expect(res.status()).toBe(400);
	});

	test('validates API key format for anthropic', async ({ page }) => {
		await page.goto('/');
		await authenticate(page);

		const { company, headers } = await createCompany(page);

		const res = await page.request.post(`/api/companies/${company.id}/ai-providers`, {
			headers: { ...headers, 'Content-Type': 'application/json' },
			data: { provider: 'anthropic', api_key: 'wrong-prefix-key' },
		});
		expect(res.status()).toBe(400);
		const body = await res.json();
		expect(body.error.code).toBe('INVALID_KEY_FORMAT');
	});
});
