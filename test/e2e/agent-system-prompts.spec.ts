import { expect, test } from '@playwright/test';
import { authenticate, createTeamWithAgents } from './helpers';

test('agent settings page shows system prompt textarea, edits persist, revisions panel lists history', async ({
	page,
}) => {
	await page.goto('/');
	await authenticate(page);

	const { team, token } = await createTeamWithAgents(page);

	const agentsRes = await page.request.get(`/api/teams/${team.id}/agents`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const engineer = agents.find((a) => a.slug === 'engineer')!;

	await page.goto(`/teams/${team.id}/agents/${engineer.id}/settings`);

	const promptTextarea = page.getByLabel('System Prompt');
	await expect(promptTextarea).toBeVisible({ timeout: 15000 });

	const original = await promptTextarea.inputValue();
	expect(original).toContain('You are an Engineer at');

	await promptTextarea.fill(`${original}\n- New rule added by e2e test`);
	// Wait for the PATCH to land before reloading — otherwise the reload races
	// the save and the revision panel comes up empty.
	const savePromise = page.waitForResponse(
		(r) => /\/agents\/[^/]+$/.test(new URL(r.url()).pathname) && r.request().method() === 'PATCH',
	);
	await page.getByRole('button', { name: 'Save Changes' }).click();
	await savePromise;

	await page.reload();
	await expect(page.getByLabel('System Prompt')).toBeVisible({ timeout: 15000 });
	await page.getByRole('button', { name: /Show revision history/i }).click();
	await expect(page.getByText(/Rev \d+/)).toBeVisible({ timeout: 15000 });
});

test('agent settings preview tab resolves placeholders and edit tab keeps the raw template', async ({
	page,
}) => {
	await page.goto('/');
	await authenticate(page);

	const { team, token } = await createTeamWithAgents(page);

	const agentsRes = await page.request.get(`/api/teams/${team.id}/agents`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const engineer = agents.find((a) => a.slug === 'engineer')!;

	await page.goto(`/teams/${team.id}/agents/${engineer.id}/settings`);

	const editTextarea = page.getByLabel('System Prompt');
	await expect(editTextarea).toBeVisible({ timeout: 15000 });
	const raw = await editTextarea.inputValue();
	expect(raw.length).toBeGreaterThan(0);

	await page.getByRole('tab', { name: 'Preview' }).click();
	const preview = page.getByTestId('system-prompt-preview');
	await expect(preview).toBeVisible();
	await expect(preview).not.toContainText('{{');
	await expect(preview).toContainText(team.name);
	await expect(preview).toContainText('Working Guidelines');
	await expect(preview).not.toContainText('Run Context');

	await page.getByRole('tab', { name: 'Edit' }).click();
	await expect(page.getByLabel('System Prompt')).toHaveValue(raw);
});
