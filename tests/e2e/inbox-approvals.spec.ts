import { expect, test } from '@playwright/test';
import { authenticate, createCompanyWithAgents, waitForPageLoad } from './helpers';

test.describe('Inbox / Approvals', () => {
	test('inbox shows empty state when no approvals', async ({ page }) => {
		await authenticate(page);
		const { company } = await createCompanyWithAgents(page);

		await page.goto(`/companies/${company.slug}/inbox`);
		await waitForPageLoad(page);

		await expect(page.getByText('All clear')).toBeVisible({ timeout: 5000 });
		await expect(page.getByText('No pending approvals')).toBeVisible();
	});

	test('inbox shows pending approval with type badge', async ({ page }) => {
		await authenticate(page);
		const { company, token } = await createCompanyWithAgents(page);
		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

		// Create a pending approval via API
		await page.request.post(`/api/companies/${company.id}/approvals`, {
			headers,
			data: {
				type: 'strategy',
				payload: { plan: 'Launch new product line' },
			},
		});

		await page.goto(`/companies/${company.slug}/inbox`);
		await waitForPageLoad(page);

		// Verify approval card is visible with friendly message
		await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible({ timeout: 5000 });
		await expect(page.getByText('Proposing strategy')).toBeVisible();
		await expect(page.getByText('Launch new product line')).toBeVisible();

		// Verify approve/deny buttons
		await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Deny' })).toBeVisible();
	});

	test('can approve a pending approval', async ({ page }) => {
		await authenticate(page);
		const { company, token } = await createCompanyWithAgents(page);
		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

		await page.request.post(`/api/companies/${company.id}/approvals`, {
			headers,
			data: {
				type: 'hire',
				payload: {
					title: 'New Designer',
					slug: `new-designer-${Date.now()}`,
					system_prompt: 'You are a designer.',
				},
			},
		});

		await page.goto(`/companies/${company.slug}/inbox`);
		await waitForPageLoad(page);

		await expect(page.getByText('Proposing to hire')).toBeVisible({ timeout: 5000 });

		// Click approve
		await page.getByRole('button', { name: 'Approve' }).click();

		// After approval, should show empty state
		await expect(page.getByText('All clear')).toBeVisible({ timeout: 10000 });
	});

	test('can deny a pending approval', async ({ page }) => {
		await authenticate(page);
		const { company, token } = await createCompanyWithAgents(page);
		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

		await page.request.post(`/api/companies/${company.id}/approvals`, {
			headers,
			data: {
				type: 'secret_access',
				payload: { secret_name: 'DB_PASSWORD' },
			},
		});

		await page.goto(`/companies/${company.slug}/inbox`);
		await waitForPageLoad(page);

		await expect(page.getByText('Requesting access to secret')).toBeVisible({ timeout: 5000 });

		// Click deny
		await page.getByRole('button', { name: 'Deny' }).click();

		// After denial, should show empty state
		await expect(page.getByText('All clear')).toBeVisible({ timeout: 10000 });
	});

	test('sidebar has Inbox link', async ({ page }) => {
		await authenticate(page);
		const { company } = await createCompanyWithAgents(page);

		await page.goto(`/companies/${company.slug}/projects`);
		await waitForPageLoad(page);

		// Sidebar should contain Inbox link
		await expect(page.getByText('Inbox', { exact: true })).toBeVisible({ timeout: 5000 });
	});

	test('global inbox aggregates approvals from every company', async ({ page }) => {
		await authenticate(page);
		const first = await createCompanyWithAgents(page);
		const second = await createCompanyWithAgents(page);
		const headers = {
			Authorization: `Bearer ${first.token}`,
			'Content-Type': 'application/json',
		};

		await page.request.post(`/api/companies/${first.company.id}/approvals`, {
			headers,
			data: { type: 'strategy', payload: { plan: 'First company strategy' } },
		});
		await page.request.post(`/api/companies/${second.company.id}/approvals`, {
			headers,
			data: { type: 'plan_review', payload: { plan: 'Second company plan' } },
		});

		await page.goto('/inbox');
		await waitForPageLoad(page);

		await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible({ timeout: 5000 });
		// Both approval types render friendly messages scoped to their company card.
		// Other tests can leave pending approvals in unrelated companies, so scope
		// the assertions to the specific approval cards for the companies we created.
		const firstCard = page
			.locator('[data-testid="approval-card"]')
			.filter({ hasText: first.company.name });
		const secondCard = page
			.locator('[data-testid="approval-card"]')
			.filter({ hasText: second.company.name });
		await expect(firstCard.getByText('Proposing strategy')).toBeVisible();
		await expect(secondCard.getByText('Requesting plan review')).toBeVisible();
	});

	test('rail inbox icon navigates to global inbox', async ({ page }) => {
		await authenticate(page);
		await createCompanyWithAgents(page);

		await page.goto('/companies');
		await waitForPageLoad(page);

		await page.getByTitle('Inbox').click();
		await expect(page).toHaveURL(/\/inbox$/);
		await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible({ timeout: 5000 });
	});
});
