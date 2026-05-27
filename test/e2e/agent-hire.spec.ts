import { expect, test } from './fixtures';
import { uniqueName } from './helpers';

test('can hire an agent with minimal fields', async ({ sharedPage: page, sharedWorkspace }) => {
	const { team } = sharedWorkspace;
	await page.goto(`/teams/${team.slug}/agents/hire`);

	const role = uniqueName('Data Scientist');
	await page.getByLabel('Role title').fill(role);
	await page.getByRole('button', { name: 'Hire agent' }).click();

	await expect(page).toHaveURL(/\/tasks\//, { timeout: 20000 });
	await expect(page.getByText(`Onboard new agent: ${role}`)).toBeVisible({ timeout: 15000 });
});

test('template variable chips insert into system prompt', async ({
	sharedPage: page,
	sharedWorkspace,
}) => {
	const { team } = sharedWorkspace;
	await page.goto(`/teams/${team.slug}/agents/hire`);

	await expect(page.getByText('{{team_name}}')).toBeVisible({ timeout: 15000 });
	await expect(page.getByText('{{agent_role}}')).toBeVisible({ timeout: 15000 });

	await page.getByRole('button', { name: '{{team_name}}' }).click();
	await page.getByRole('button', { name: '{{agent_role}}' }).click();

	const textarea = page.locator('textarea');
	const value = await textarea.inputValue();
	expect(value).toContain('{{team_name}}');
	expect(value).toContain('{{agent_role}}');
});

test('can hire agent with full fields', async ({ sharedPage: page, sharedWorkspace }) => {
	const { team } = sharedWorkspace;
	await page.goto(`/teams/${team.slug}/agents/hire`);

	const role = uniqueName('Security Auditor');
	await page.getByLabel('Role title').fill(role);
	await page.getByLabel('Role description').fill('Audits code for security vulnerabilities');

	await page.locator('select').selectOption('120');

	await page.getByLabel('Monthly budget').fill('50');

	await page.getByLabel('Touches code').check();

	await page.locator('textarea').fill('You are the Security Auditor.');

	await page.getByRole('button', { name: 'Hire agent' }).click();

	await expect(page).toHaveURL(/\/tasks\//, { timeout: 20000 });
	await expect(page.getByText(`Onboard new agent: ${role}`)).toBeVisible({
		timeout: 15000,
	});
});
