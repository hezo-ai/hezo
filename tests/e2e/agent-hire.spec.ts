import { expect, test } from '@playwright/test';
import { authenticate, createCompanyWithAgents } from './helpers';

test('can hire an agent with minimal fields', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company } = await createCompanyWithAgents(page);
	await page.goto(`/companies/${company.slug}/agents/hire`);

	await page.getByLabel('Role title').fill('Data Scientist');
	await page.getByRole('button', { name: 'Hire agent' }).click();

	// Onboarding flow redirects to the issue page (CEO reviews the hire)
	await expect(page).toHaveURL(/\/issues\//, { timeout: 10000 });
	await expect(page.getByText('Onboard new agent: Data Scientist')).toBeVisible({ timeout: 15000 });
});

test('template variable chips insert into system prompt', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company } = await createCompanyWithAgents(page);
	await page.goto(`/companies/${company.slug}/agents/hire`);

	await expect(page.getByText('{{company_name}}')).toBeVisible({ timeout: 15000 });
	await expect(page.getByText('{{agent_role}}')).toBeVisible({ timeout: 15000 });

	await page.getByRole('button', { name: '{{company_name}}' }).click();
	await page.getByRole('button', { name: '{{agent_role}}' }).click();

	const textarea = page.locator('textarea');
	const value = await textarea.inputValue();
	expect(value).toContain('{{company_name}}');
	expect(value).toContain('{{agent_role}}');
});

test('can hire agent with full fields', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company } = await createCompanyWithAgents(page);
	await page.goto(`/companies/${company.slug}/agents/hire`);

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
	await expect(page).toHaveURL(/\/issues\//, { timeout: 10000 });
	await expect(page.getByText('Onboard new agent: Security Auditor')).toBeVisible({
		timeout: 15000,
	});
});
