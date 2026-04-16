import { expect, test } from '@playwright/test';
import { authenticate, configureAiProvider, getToken } from './helpers';

async function createCompany(page: import('@playwright/test').Page) {
	const token = await getToken(page);
	const headers = { Authorization: `Bearer ${token}` };

	const companyRes = await page.request.post('/api/companies', {
		headers,
		data: {
			name: `Settings Corp ${Date.now()}`,
			issue_prefix: `ST${Date.now().toString().slice(-4)}`,
			description: 'Build great things',
		},
	});
	const company = (await companyRes.json()).data;
	await configureAiProvider(page, company.id, headers);
	return { company, token, headers };
}

test('general section displays company info', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company } = await createCompany(page);
	await page.goto(`/companies/${company.slug}/settings`);

	const generalSection = page.locator('#settings-general');
	await expect(generalSection.getByRole('heading', { name: 'General' })).toBeVisible({
		timeout: 5000,
	});
	await expect(generalSection.getByText(company.name)).toBeVisible({ timeout: 5000 });
	await expect(generalSection.getByText('Build great things')).toBeVisible({ timeout: 5000 });
});

test('can add and delete a secret', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company } = await createCompany(page);
	await page.goto(`/companies/${company.slug}/settings`);

	const secretsSection = page.locator('#settings-secrets');
	await expect(secretsSection.getByText('Secrets vault')).toBeVisible({ timeout: 5000 });

	await secretsSection.getByRole('button', { name: 'Add' }).click();
	await secretsSection.getByPlaceholder('Name').fill('MY_SECRET');
	await secretsSection.getByPlaceholder('Value').fill('supersecret');
	await secretsSection.locator('form').getByRole('button', { name: 'Add' }).click();

	await expect(secretsSection.getByText('MY_SECRET')).toBeVisible({ timeout: 5000 });

	await secretsSection.locator('button:has(svg)').last().click();

	await expect(secretsSection.getByText('No secrets stored.')).toBeVisible({ timeout: 5000 });
});

test('can create and delete an api key', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company } = await createCompany(page);
	await page.goto(`/companies/${company.slug}/settings`);

	const apiKeysSection = page.locator('#settings-api-keys');
	await expect(apiKeysSection.getByRole('heading', { name: 'API keys' })).toBeVisible({
		timeout: 5000,
	});

	await apiKeysSection.getByRole('button', { name: 'Create' }).click();
	await apiKeysSection.getByPlaceholder('Key name').fill('Test Key');
	await apiKeysSection.locator('form').getByRole('button', { name: 'Create' }).click();

	await expect(page.getByText('New API key created')).toBeVisible({ timeout: 5000 });
	await expect(page.locator('code').filter({ hasText: 'hezo_' })).toBeVisible({ timeout: 5000 });

	await page.getByRole('button', { name: 'Dismiss' }).click();
	await expect(apiKeysSection.getByText('Test Key')).toBeVisible({ timeout: 5000 });

	await apiKeysSection.locator('button:has(svg)').last().click();

	await expect(apiKeysSection.getByText('No API keys.')).toBeVisible({ timeout: 5000 });
});

test('can edit and save preferences', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company } = await createCompany(page);
	await page.goto(`/companies/${company.slug}/settings`);

	const prefsSection = page.locator('#settings-preferences');
	await expect(prefsSection.getByRole('heading', { name: 'Preferences' })).toBeVisible({
		timeout: 5000,
	});
	await expect(prefsSection.getByText('No preferences set.')).toBeVisible({ timeout: 5000 });

	await prefsSection.getByRole('button', { name: 'Edit' }).click();
	await prefsSection.locator('textarea').fill('Always be concise.');
	await prefsSection.getByRole('button', { name: 'Save' }).click();

	await expect(prefsSection.getByRole('button', { name: 'Edit' })).toBeVisible({ timeout: 5000 });
	await expect(prefsSection.getByText('Always be concise.')).toBeVisible({ timeout: 5000 });

	await page.reload();
	await expect(page.locator('#settings-preferences').getByText('Always be concise.')).toBeVisible({
		timeout: 10000,
	});
});

test('can add and delete an mcp server', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company } = await createCompany(page);
	await page.goto(`/companies/${company.slug}/settings`);

	const mcpSection = page.locator('#settings-mcp');
	await expect(mcpSection.getByRole('heading', { name: 'MCP servers' })).toBeVisible({
		timeout: 5000,
	});
	await expect(mcpSection.getByText('No MCP servers configured.')).toBeVisible({ timeout: 5000 });

	await mcpSection.getByRole('button', { name: 'Add MCP Server' }).click();
	await mcpSection.getByPlaceholder('Server name').fill('Test MCP');
	await mcpSection.getByPlaceholder(/URL/).fill('http://localhost:9999/mcp');
	await mcpSection.getByRole('button', { name: 'Add' }).click();

	await expect(mcpSection.getByText('Test MCP')).toBeVisible({ timeout: 5000 });
	await expect(mcpSection.getByText('localhost:9999')).toBeVisible({ timeout: 5000 });

	await mcpSection
		.getByRole('button', { name: /Trash|Delete/i })
		.or(mcpSection.locator('button:has(svg.lucide-trash-2)'))
		.click();

	await expect(mcpSection.getByText('No MCP servers configured.')).toBeVisible({ timeout: 5000 });
});
