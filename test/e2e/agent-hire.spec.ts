import { expect, test } from '@playwright/test';
import { authenticate, createTeamWithAgents } from './helpers';

test('can hire an agent with minimal fields', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { team } = await createTeamWithAgents(page);
	await page.goto(`/teams/${team.slug}/agents/hire`);

	await page.getByLabel('Role title').fill('Data Scientist');
	await page.getByRole('button', { name: 'Hire agent' }).click();

	// Onboarding flow redirects to the issue page (CEO reviews the hire)
	await expect(page).toHaveURL(/\/issues\//, { timeout: 20000 });
	await expect(page.getByText('Onboard new agent: Data Scientist')).toBeVisible({ timeout: 15000 });
});

test('template variable chips insert into system prompt', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { team } = await createTeamWithAgents(page);
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

test('can hire agent with full fields', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { team } = await createTeamWithAgents(page);
	await page.goto(`/teams/${team.slug}/agents/hire`);

	await page.getByLabel('Role title').fill('Security Auditor');
	await page.getByLabel('Role description').fill('Audits code for security vulnerabilities');

	// Set heartbeat
	await page.locator('select').selectOption('120');

	// Set budget
	await page.getByLabel('Monthly budget').fill('50');

	// Tick the touches-code capability
	await page.getByLabel('Touches code').check();

	// Type system prompt
	await page.locator('textarea').fill('You are the Security Auditor.');

	await page.getByRole('button', { name: 'Hire agent' }).click();

	// Onboarding flow redirects to the issue page
	await expect(page).toHaveURL(/\/issues\//, { timeout: 20000 });
	await expect(page.getByText('Onboard new agent: Security Auditor')).toBeVisible({
		timeout: 15000,
	});
});
