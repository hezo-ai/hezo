import { expect, test } from '@playwright/test';
import { authenticate, createCompanyWithAgents } from './helpers';

test('can hire an agent with minimal fields', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company } = await createCompanyWithAgents(page);
	await page.goto(`/companies/${company.slug}/agents/hire`);

	await page.getByLabel('Role title').fill('Data Scientist');
	await page.getByRole('button', { name: 'Hire agent' }).click();

	await expect(page).toHaveURL(/\/agents\//, { timeout: 10000 });
	await expect(page.getByText('Data Scientist')).toBeVisible({ timeout: 5000 });
});

test('template variable chips insert into system prompt', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company } = await createCompanyWithAgents(page);
	await page.goto(`/companies/${company.slug}/agents/hire`);

	await expect(page.getByText('{{company_name}}')).toBeVisible({ timeout: 5000 });
	await expect(page.getByText('{{agent_role}}')).toBeVisible({ timeout: 5000 });

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
	await page.getByLabel('Slug').fill('security-auditor');

	// Select runtime
	await page.locator('select').filter({ hasText: 'Claude Code' }).selectOption('codex');

	// Select a reports-to agent
	const reportsToSelect = page.locator('select').filter({ hasText: 'None (Board)' });
	const options = await reportsToSelect.locator('option').allTextContents();
	const agentOption = options.find((o) => o !== 'None (Board)');
	if (agentOption) {
		await reportsToSelect.selectOption({ label: agentOption });
	}

	// Set heartbeat
	await page.locator('select').filter({ hasText: '60m' }).selectOption('120');

	// Set budget
	await page.getByLabel('Monthly budget').fill('50');

	// Type system prompt
	await page.locator('textarea').fill('You are the Security Auditor.');

	await page.getByRole('button', { name: 'Hire agent' }).click();

	await expect(page).toHaveURL(/\/agents\//, { timeout: 10000 });
	await expect(page.getByText('Security Auditor')).toBeVisible({ timeout: 5000 });
	await expect(page.getByText('Budget Usage')).toBeVisible({ timeout: 5000 });
});
