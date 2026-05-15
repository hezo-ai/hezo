import { expect, test } from '@playwright/test';
import { authenticate, createCompanyWithAgents, waitForPageLoad } from './helpers';

test.describe('Comment reactions (mobile)', () => {
	test('reaction chip is tappable on a 390px viewport', async ({ page }) => {
		await authenticate(page);
		const { company, token } = await createCompanyWithAgents(page);
		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

		const projRes = await page.request.post(`/api/companies/${company.id}/projects`, {
			headers,
			data: { name: 'Reactions Mobile', description: 'x' },
		});
		const project = ((await projRes.json()) as { data: { id: string } }).data;

		const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		const agents = ((await agentsRes.json()) as { data: Array<{ id: string }> }).data;

		const issueRes = await page.request.post(`/api/companies/${company.id}/issues`, {
			headers,
			data: {
				project_id: project.id,
				title: 'Mobile Reactions',
				assignee_id: agents[0].id,
			},
		});
		const issue = ((await issueRes.json()) as { data: { id: string } }).data;

		await page.request.post(`/api/companies/${company.id}/issues/${issue.id}/comments`, {
			headers,
			data: { content_type: 'text', content: { text: 'react to me on mobile' } },
		});

		await page.goto(`/companies/${company.slug}/issues/${issue.id}`);
		await waitForPageLoad(page);

		const addButton = page.getByTestId('add-reaction-button').first();
		await expect(addButton).toBeVisible({ timeout: 20_000 });

		// Verify minimum tap-target size on the small viewport.
		const box = await addButton.boundingBox();
		expect(box).not.toBeNull();
		expect(box!.height).toBeGreaterThanOrEqual(28);
		expect(box!.width).toBeGreaterThanOrEqual(28);

		await addButton.click();
		const picker = page.getByTestId('reaction-picker');
		await expect(picker).toBeVisible();
		await picker.locator('[data-reaction-kind="ack"]').click();

		const chip = page
			.getByTestId('comment-reactions')
			.locator('[data-reaction-kind="ack"]')
			.first();
		await expect(chip).toBeVisible({ timeout: 15_000 });
		await expect(chip).toContainText('1');
		const chipBox = await chip.boundingBox();
		expect(chipBox).not.toBeNull();
		expect(chipBox!.height).toBeGreaterThanOrEqual(28);
	});
});
