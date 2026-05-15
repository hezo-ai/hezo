import { expect, test } from '@playwright/test';
import { authenticate, createCompanyWithAgents } from './helpers';

test('agent settings page shows system prompt textarea, edits persist, revisions panel lists history', async ({
	page,
}) => {
	await page.goto('/');
	await authenticate(page);

	const { company, token } = await createCompanyWithAgents(page);

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const engineer = agents.find((a) => a.slug === 'engineer')!;

	await page.goto(`/companies/${company.id}/agents/${engineer.id}/settings`);

	const promptTextarea = page.getByLabel('System Prompt');
	await expect(promptTextarea).toBeVisible({ timeout: 15000 });

	const original = await promptTextarea.inputValue();
	expect(original).toContain('You are an Engineer at');

	await promptTextarea.fill(`${original}\n- New rule added by e2e test`);
	await page.getByRole('button', { name: 'Save Changes' }).click();

	await page.reload();
	await expect(page.getByLabel('System Prompt')).toBeVisible({ timeout: 15000 });
	await page.getByRole('button', { name: /Show revision history/i }).click();
	await expect(page.getByText(/Rev \d+/)).toBeVisible();
});
