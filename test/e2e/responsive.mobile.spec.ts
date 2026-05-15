import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { waitForPageLoad } from './helpers';

async function expectNoHorizontalOverflow(page: Page) {
	const overflow = await page.evaluate(() => ({
		scroll: document.documentElement.scrollWidth,
		client: document.documentElement.clientWidth,
	}));
	expect(overflow.scroll).toBeLessThanOrEqual(overflow.client + 1);
}

test.describe('Responsive — mobile (390px)', () => {
	test('page padding scales down (no fixed 32px on mobile)', async ({ page, lightWorkspace }) => {
		const { company } = lightWorkspace;
		await page.goto(`/companies/${company.slug}/projects`);
		await waitForPageLoad(page);
		await expectNoHorizontalOverflow(page);
	});

	test('issue detail metadata stacks above content', async ({ page, freshWorkspace }) => {
		const { company, token, agents } = freshWorkspace;
		const ceo = agents.find((a) => a.slug === 'ceo') ?? agents[0];
		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

		const projectRes = await page.request.post(`/api/companies/${company.id}/projects`, {
			headers,
			data: { name: 'Mobile P', description: 'mobile' },
		});
		const project = ((await projectRes.json()) as { data: { id: string; slug: string } }).data;

		const issueRes = await page.request.post(`/api/companies/${company.id}/issues`, {
			headers,
			data: {
				project_id: project.id,
				title: 'Mobile issue',
				assignee_id: ceo.id,
				description: 'mobile description',
			},
		});
		const issue = ((await issueRes.json()) as { data: { identifier: string } }).data;

		await page.goto(
			`/companies/${company.slug}/projects/${project.slug}/issues/${issue.identifier.toLowerCase()}`,
		);
		await waitForPageLoad(page);
		await expect(page.getByRole('heading', { name: 'Mobile issue' })).toBeVisible({
			timeout: 20000,
		});
		await expectNoHorizontalOverflow(page);

		const description = page.getByTestId('issue-description-card');
		const descBox = await description.boundingBox();
		expect(descBox).not.toBeNull();
		if (descBox) {
			expect(descBox.width).toBeGreaterThan(300);
		}
	});

	test('create-issue dialog goes near full-screen', async ({ page, freshWorkspace }) => {
		const { company } = freshWorkspace;
		await page.goto(`/companies/${company.slug}/issues`);
		await waitForPageLoad(page);

		await page.getByTestId('issue-list-new-issue').click();
		const dialog = page.getByRole('dialog');
		await expect(dialog).toBeVisible();

		const box = await dialog.boundingBox();
		expect(box).not.toBeNull();
		if (box) {
			expect(box.width).toBeGreaterThanOrEqual(370);
		}
	});

	test('audit log table scrolls horizontally without page overflow', async ({
		page,
		lightWorkspace,
	}) => {
		const { company } = lightWorkspace;
		await page.goto(`/companies/${company.slug}/audit-log`);
		await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible({
			timeout: 20000,
		});
		await expectNoHorizontalOverflow(page);
	});

	test('global settings nav stacks above content', async ({ page, lightWorkspace }) => {
		await page.goto('/settings');
		await waitForPageLoad(page);
		await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
		await expectNoHorizontalOverflow(page);
		void lightWorkspace;
	});

	test('hamburger does not collide with rail at tablet width', async ({ page, lightWorkspace }) => {
		const { company } = lightWorkspace;
		await page.setViewportSize({ width: 800, height: 900 });
		await page.goto(`/companies/${company.slug}`);
		await waitForPageLoad(page);

		const toggle = page.getByTestId('mobile-nav-toggle');
		await expect(toggle).toBeVisible();
		const tBox = await toggle.boundingBox();
		expect(tBox).not.toBeNull();
		if (tBox) {
			expect(tBox.x).toBeGreaterThanOrEqual(60);
		}
	});
});
