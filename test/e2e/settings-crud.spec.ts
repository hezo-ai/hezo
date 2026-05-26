import { expect, test } from '@playwright/test';
import { authenticate, getToken } from './helpers';

async function createTeam(page: import('@playwright/test').Page) {
	const token = await getToken(page);
	const headers = { Authorization: `Bearer ${token}` };

	const teamRes = await page.request.post('/api/teams', {
		headers,
		data: {
			name: `Settings Corp ${Date.now()}`,
			description: 'Build great things',
		},
	});
	const team = (await teamRes.json()).data;
	return { team, token, headers };
}

test('general section displays team info', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { team } = await createTeam(page);
	await page.goto(`/teams/${team.slug}/settings/general`);

	const generalSection = page.locator('#settings-general');
	await expect(generalSection.getByRole('heading', { name: 'General' })).toBeVisible({
		timeout: 15000,
	});
	await expect(generalSection.getByText(team.name)).toBeVisible({ timeout: 15000 });
	await expect(generalSection.getByText('Build great things')).toBeVisible({ timeout: 15000 });
});

test('automations section exposes the wake-mentioner toggle and persists the change', async ({
	page,
}) => {
	await page.goto('/');
	await authenticate(page);

	const { team, token } = await createTeam(page);
	await page.goto(`/teams/${team.slug}/settings/general`);

	const automations = page.locator('#settings-automations');
	await expect(automations.getByRole('heading', { name: 'Automations' })).toBeVisible({
		timeout: 15000,
	});

	const toggle = automations.getByRole('checkbox', { name: /wake mentioner on reply/i });
	await expect(toggle).toBeChecked();

	const teamPatch = (r: import('@playwright/test').Response) =>
		r.url().endsWith(`/teams/${team.slug}`) && r.request().method() === 'PATCH';

	await Promise.all([page.waitForResponse(teamPatch), toggle.click()]);
	await expect(toggle).not.toBeChecked({ timeout: 30000 });

	const res = await page.request.get(`/api/teams/${team.id}`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const persisted = (await res.json()).data.settings;
	expect(persisted.wake_mentioner_on_reply).toBe(false);

	await Promise.all([page.waitForResponse(teamPatch), toggle.click()]);
	await expect(toggle).toBeChecked({ timeout: 30000 });
});

test('can add and delete a secret', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { team } = await createTeam(page);
	await page.goto(`/teams/${team.slug}/settings/general`);

	const secretsSection = page.locator('#settings-secrets');
	await expect(secretsSection.getByText('Secrets vault')).toBeVisible({ timeout: 15000 });

	await secretsSection.getByRole('button', { name: 'Add' }).click();
	await secretsSection.getByPlaceholder(/^Name/).fill('MY_SECRET');
	await secretsSection.getByPlaceholder('Value').fill('supersecret');
	await secretsSection.getByPlaceholder(/Allowed hosts/).fill('example.com');
	await Promise.all([
		page.waitForResponse(
			(r) => r.url().endsWith(`/teams/${team.slug}/secrets`) && r.request().method() === 'POST',
		),
		secretsSection.locator('form').getByRole('button', { name: 'Add' }).click(),
	]);

	await expect(secretsSection.getByText('MY_SECRET')).toBeVisible({ timeout: 15000 });

	await secretsSection.locator('button:has(svg)').last().click();

	await expect(secretsSection.getByText('No secrets stored.')).toBeVisible({ timeout: 15000 });
});

test('can create and delete an api key', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { team } = await createTeam(page);
	await page.goto(`/teams/${team.slug}/settings/general`);

	const apiKeysSection = page.locator('#settings-api-keys');
	await expect(apiKeysSection.getByRole('heading', { name: 'API keys' })).toBeVisible({
		timeout: 15000,
	});

	await apiKeysSection.getByRole('button', { name: 'Create' }).click();
	await apiKeysSection.getByPlaceholder('Key name').fill('Test Key');
	await Promise.all([
		page.waitForResponse(
			(r) => r.url().endsWith(`/teams/${team.slug}/api-keys`) && r.request().method() === 'POST',
		),
		apiKeysSection.locator('form').getByRole('button', { name: 'Create' }).click(),
	]);

	await expect(page.getByText('New API key created')).toBeVisible({ timeout: 15000 });
	await expect(page.locator('code').filter({ hasText: 'hezo_' })).toBeVisible({ timeout: 15000 });

	await page.getByRole('button', { name: 'Dismiss' }).click();
	await expect(apiKeysSection.getByText('Test Key')).toBeVisible({ timeout: 15000 });

	await apiKeysSection.locator('button:has(svg)').last().click();

	await expect(apiKeysSection.getByText('No API keys.')).toBeVisible({ timeout: 15000 });
});

test('can edit and save preferences', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { team } = await createTeam(page);
	await page.goto(`/teams/${team.slug}/settings/general`);

	const prefsSection = page.locator('#settings-preferences');
	await expect(prefsSection.getByRole('heading', { name: 'Preferences' })).toBeVisible({
		timeout: 15000,
	});
	await expect(prefsSection.getByText('No preferences set.')).toBeVisible({ timeout: 15000 });

	await prefsSection.getByRole('button', { name: 'Edit' }).click();
	await prefsSection.locator('textarea').fill('Always be concise.');
	await prefsSection.getByRole('button', { name: 'Save' }).click();

	await expect(prefsSection.getByRole('button', { name: 'Edit' })).toBeVisible({ timeout: 15000 });
	await expect(prefsSection.getByText('Always be concise.')).toBeVisible({ timeout: 15000 });

	await page.reload();
	await expect(page.locator('#settings-preferences').getByText('Always be concise.')).toBeVisible({
		timeout: 20000,
	});
});

test('can restore a previous preferences revision', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { team, headers } = await createTeam(page);

	await page.request.patch(`/api/teams/${team.id}/preferences`, {
		headers,
		data: { content: 'Original preferences body' },
	});
	await page.request.patch(`/api/teams/${team.id}/preferences`, {
		headers,
		data: { content: 'Updated preferences body', change_summary: 'second pass' },
	});

	await page.goto(`/teams/${team.slug}/settings/general`);
	const prefsSection = page.locator('#settings-preferences');
	await expect(prefsSection.getByText('Updated preferences body')).toBeVisible({ timeout: 15000 });

	await prefsSection.getByRole('button', { name: /show revision history/i }).click();
	await expect(prefsSection.getByText(/Rev 1/)).toBeVisible({ timeout: 15000 });

	await prefsSection
		.getByRole('button', { name: /restore/i })
		.first()
		.click();
	await page.getByTestId('confirm-dialog-confirm').click();
	await expect(prefsSection.getByText('Original preferences body')).toBeVisible({ timeout: 30000 });
});

test('can add and delete an mcp server', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { team } = await createTeam(page);
	await page.goto(`/teams/${team.slug}/settings/general`);

	const mcpSection = page.locator('#settings-mcp');
	await expect(mcpSection.getByRole('heading', { name: 'MCP servers' })).toBeVisible({
		timeout: 15000,
	});
	await expect(mcpSection.getByText('No MCP servers configured.')).toBeVisible({ timeout: 15000 });

	await mcpSection.getByRole('button', { name: 'Add MCP Server' }).click();
	await mcpSection.getByPlaceholder('Server name').fill('Test MCP');
	await mcpSection.getByPlaceholder(/URL/).fill('http://localhost:9999/mcp');
	await mcpSection.getByRole('button', { name: 'Add' }).click();

	await expect(mcpSection.getByText('Test MCP')).toBeVisible({ timeout: 30000 });
	await expect(mcpSection.getByText('localhost:9999')).toBeVisible({ timeout: 30000 });

	await mcpSection
		.getByRole('button', { name: /Trash|Delete/i })
		.or(mcpSection.locator('button:has(svg.lucide-trash-2)'))
		.click();

	await expect(mcpSection.getByText('No MCP servers configured.')).toBeVisible({ timeout: 30000 });
});
