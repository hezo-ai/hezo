import { expect, test } from '@playwright/test';
import { authenticate, createCompanyWithAgents, getToken } from './helpers';

test('sidebar can be collapsed and the state persists across reload', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company } = await createCompanyWithAgents(page);
	await page.goto(`/companies/${company.slug}/inbox`);

	// Sidebar visible by default — Resources section header is in the CompanySidebar
	await expect(page.getByText('Resources').first()).toBeVisible({ timeout: 10000 });

	const toggle = page.getByTestId('sidebar-toggle');
	await expect(toggle).toBeVisible();
	await expect(toggle).toHaveAccessibleName('Collapse sidebar');

	const [uiStateResponse] = await Promise.all([
		page.waitForResponse((r) => r.url().includes('/ui-state') && r.request().method() === 'PATCH'),
		toggle.click(),
	]);
	expect(uiStateResponse.ok()).toBe(true);
	await expect(toggle).toHaveAccessibleName('Expand sidebar', { timeout: 15000 });
	await expect(page.getByText('Resources').first()).toBeHidden({ timeout: 15000 });

	await page.reload();
	await expect(page.getByTestId('sidebar-toggle')).toHaveAccessibleName('Expand sidebar', {
		timeout: 10000,
	});
	await expect(page.getByText('Resources').first()).toBeHidden({ timeout: 15000 });

	await page.getByTestId('sidebar-toggle').click();
	await expect(page.getByText('Resources').first()).toBeVisible({ timeout: 15000 });
});

test('sidebar toggle stays clickable when the container status banner is showing', async ({
	page,
}) => {
	await page.goto('/');
	await authenticate(page);

	const { company } = await createCompanyWithAgents(page);
	const token = await getToken(page);
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

	const projRes = await page.request.post(`/api/companies/${company.id}/projects`, {
		headers,
		data: { name: 'Banner Regression Project', description: 'Forces the unhealthy banner.' },
	});
	const project = ((await projRes.json()) as { data: { slug: string } }).data;

	await expect
		.poll(
			async () => {
				const res = await page.request.get(
					`/api/companies/${company.id}/projects/${project.slug}`,
					{ headers },
				);
				const body = (await res.json()) as { data: { container_status: string | null } };
				return body.data.container_status;
			},
			{ timeout: 30000, intervals: [500] },
		)
		.toMatch(/^(running|error)$/);

	await page.request.post(`/api/companies/${company.id}/projects/${project.slug}/container/stop`, {
		headers,
	});

	await expect
		.poll(
			async () => {
				const res = await page.request.get(
					`/api/companies/${company.id}/projects/${project.slug}`,
					{ headers },
				);
				const body = (await res.json()) as { data: { container_status: string | null } };
				return body.data.container_status;
			},
			{ timeout: 60000, intervals: [500] },
		)
		.toMatch(/^(stopped|error)$/);

	await page.goto(`/companies/${company.slug}/inbox`);

	await expect(page.getByTestId('container-status-banner')).toBeVisible({ timeout: 10000 });
	await expect(page.getByTestId('container-status-banner')).toContainText(/container failed/i);

	const toggle = page.getByTestId('sidebar-toggle');
	await expect(toggle).toBeVisible();
	await expect(toggle).toHaveAccessibleName('Collapse sidebar');

	await toggle.click();
	await expect(toggle).toHaveAccessibleName('Expand sidebar', { timeout: 15000 });
});
