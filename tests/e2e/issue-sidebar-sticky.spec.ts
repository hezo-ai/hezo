import { expect, test } from '@playwright/test';
import { authenticate, createCompanyWithAgents, waitForPageLoad } from './helpers';

test.describe('Issue detail right sidebar', () => {
	async function createProjectAndIssue(page: import('@playwright/test').Page) {
		const { company, token } = await createCompanyWithAgents(page);
		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

		const projRes = await page.request.post(`/api/companies/${company.id}/projects`, {
			headers,
			data: { name: 'Sidebar Project', description: 'Sidebar test project.' },
		});
		const project = ((await projRes.json()) as any).data;

		const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		const agents = ((await agentsRes.json()) as any).data;
		const agent = agents[0];

		const issueRes = await page.request.post(`/api/companies/${company.id}/issues`, {
			headers,
			data: { project_id: project.id, title: 'Sidebar Test Issue', assignee_id: agent.id },
		});
		const issue = ((await issueRes.json()) as any).data;

		return { company, headers, issue };
	}

	test('floats (sticky) as the page scrolls on desktop', async ({ page }) => {
		await authenticate(page);
		await page.setViewportSize({ width: 1280, height: 720 });
		const { company, headers, issue } = await createProjectAndIssue(page);

		// Seed enough comments to make the page scrollable past one viewport.
		for (let i = 0; i < 25; i++) {
			await page.request.post(`/api/companies/${company.id}/issues/${issue.id}/comments`, {
				headers,
				data: {
					content_type: 'text',
					content: { text: `Filler comment ${i}. ${'lorem ipsum '.repeat(30)}` },
				},
			});
		}

		await page.goto(`/companies/${company.slug}/issues/${issue.id}`);
		await waitForPageLoad(page);

		const sidebar = page.getByTestId('issue-sidebar');
		await expect(sidebar).toBeVisible({ timeout: 20000 });

		const position = await sidebar.evaluate((el) => getComputedStyle(el).position);
		expect(position).toBe('sticky');

		const main = page.locator('main').first();
		const initialY = (await sidebar.boundingBox())?.y ?? 0;

		await main.evaluate((el) => {
			el.scrollBy(0, 800);
		});
		// Allow a paint to settle.
		await page.waitForTimeout(100);

		const scrolled = await sidebar.boundingBox();
		expect(scrolled).not.toBeNull();
		// Sticky pins the sidebar against the scroll container's top edge instead of
		// letting it scroll out of view; its y must not drop below the initial value.
		expect(scrolled!.y).toBeLessThanOrEqual(initialY);
		// And it must still be on screen.
		expect(scrolled!.y).toBeGreaterThanOrEqual(0);
		expect(scrolled!.y + scrolled!.height).toBeLessThanOrEqual(720);
	});

	test('houses the Effort dropdown and Wake-assignee toggle (moved from the comment form)', async ({
		page,
	}) => {
		await authenticate(page);
		await page.setViewportSize({ width: 1280, height: 720 });
		const { company, issue } = await createProjectAndIssue(page);

		await page.goto(`/companies/${company.slug}/issues/${issue.id}`);
		await waitForPageLoad(page);

		const sidebar = page.getByTestId('issue-sidebar');
		await expect(sidebar).toBeVisible({ timeout: 20000 });

		const effort = sidebar.getByLabel(
			'Reasoning effort for the agent run triggered by this comment',
		);
		await expect(effort).toBeVisible();

		const wake = sidebar.getByRole('checkbox', { name: 'Wake assignee on submit' });
		await expect(wake).toBeVisible();
		await expect(wake).toBeChecked();
	});
});
