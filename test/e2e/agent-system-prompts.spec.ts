import { expect, test } from './fixtures';
import { agentMatcher } from './helpers';

test('agent settings page shows system prompt textarea, edits persist, revisions panel lists history', async ({
	page,
	freshWorkspace,
}) => {
	const { team, agents } = freshWorkspace;
	const engineer = agents.find((a) => a.slug === 'engineer')!;

	await page.goto(`/teams/${team.id}/agents/${engineer.id}/settings`);

	const promptTextarea = page.getByLabel('System Prompt');
	await expect(promptTextarea).toBeVisible({ timeout: 15000 });

	const original = await promptTextarea.inputValue();
	expect(original).toContain('You are an Engineer at');

	await promptTextarea.fill(`${original}\n- New rule added by e2e test`);
	// Scope the matcher to the specific agent's PATCH so Captain's background
	// activity on other agents doesn't satisfy the wait before our save lands.
	const matchPatch = agentMatcher({ teamId: team.id, agentId: engineer.id, method: 'PATCH' });
	const savePromise = page.waitForResponse((r) => {
		try {
			return matchPatch(new URL(r.url()), r.request().method());
		} catch {
			return false;
		}
	});
	await page.getByRole('button', { name: 'Save Changes' }).click();
	await savePromise;

	await page.reload();
	await expect(page.getByLabel('System Prompt')).toBeVisible({ timeout: 15000 });
	await page.getByRole('button', { name: /Show revision history/i }).click();
	await expect(page.getByText(/Rev \d+/)).toBeVisible({ timeout: 15000 });
});

test('agent settings preview tab resolves placeholders and edit tab keeps the raw template', async ({
	page,
	freshWorkspace,
}) => {
	const { team, agents } = freshWorkspace;
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
