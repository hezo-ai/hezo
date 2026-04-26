import { expect, test } from '@playwright/test';
import { clearAiProviders, getToken } from './helpers';

test.describe('AI provider gate (post-master-key, pre-company)', () => {
	test('blocks the app when no provider is configured and drops once one is added', async ({
		page,
	}) => {
		// Clear any pre-existing instance-level providers so the gate fires.
		const token = await getToken(page);
		await clearAiProviders(page, token);

		// Set the auth token in localStorage so the master-key gate doesn't block us.
		await page.addInitScript((t: string) => {
			localStorage.setItem('hezo_token', t);
		}, token);

		await page.goto('/');

		// The AI-provider gate should be visible with all four provider cards.
		await expect(page.getByRole('heading', { name: 'Set up an AI provider' })).toBeVisible({
			timeout: 20000,
		});
		await expect(page.getByText('Anthropic')).toBeVisible();
		await expect(page.getByText('OpenAI')).toBeVisible();
		await expect(page.getByText('Google')).toBeVisible();
		await expect(page.getByText('Moonshot')).toBeVisible();

		// Company rail / list must NOT be reachable yet.
		await expect(page.getByRole('heading', { name: 'Welcome to Hezo' })).toBeHidden();

		// Add an anthropic key via the gate UI.
		await page.getByRole('button', { name: 'Enter API key' }).first().click();
		await page.locator('input[type="password"]').first().fill('sk-ant-gate-test-12345');
		await page.getByRole('button', { name: 'Save' }).first().click();

		// Gate should drop and the app shell should render.
		await expect(page.getByRole('heading', { name: 'Set up an AI provider' })).toBeHidden({
			timeout: 20000,
		});

		// With no companies yet, we should be on the empty-state companies list.
		// (The app redirects / → /companies.)
		await expect(page).toHaveURL(/\/companies(\/|$)/);
	});

	test('re-raises the gate after deleting the last provider', async ({ page }) => {
		const token = await getToken(page);

		// Ensure at least one provider exists, then snapshot the list.
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

		// Seed localStorage token so the master-key gate doesn't block.
		await page.addInitScript((t: string) => {
			localStorage.setItem('hezo_token', t);
		}, token);

		await page.goto('/settings/ai-providers');
		await expect(page.getByRole('heading', { name: 'AI providers' })).toBeVisible();

		// Clear every provider via API, then reload to trigger the gate.
		await clearAiProviders(page, token);
		await page.reload();

		await expect(page.getByRole('heading', { name: 'Set up an AI provider' })).toBeVisible({
			timeout: 20000,
		});
	});
});
