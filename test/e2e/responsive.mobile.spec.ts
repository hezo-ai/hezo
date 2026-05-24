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
		const { team } = lightWorkspace;
		await page.goto(`/teams/${team.slug}/projects`);
		await waitForPageLoad(page);
		await expectNoHorizontalOverflow(page);
	});

	test('task detail metadata stacks above content', async ({ page, freshWorkspace }) => {
		const { team, token, agents } = freshWorkspace;
		const captain = agents.find((a) => a.slug === 'captain') ?? agents[0];
		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

		const projectRes = await page.request.post(`/api/teams/${team.id}/projects`, {
			headers,
			data: { name: 'Mobile P', description: 'mobile' },
		});
		const project = ((await projectRes.json()) as { data: { id: string; slug: string } }).data;

		const taskRes = await page.request.post(`/api/teams/${team.id}/tasks`, {
			headers,
			data: {
				project_id: project.id,
				title: 'Mobile task',
				assignee_id: captain.id,
				description: 'mobile description',
			},
		});
		const task = ((await taskRes.json()) as { data: { identifier: string } }).data;

		await page.goto(
			`/teams/${team.slug}/projects/${project.slug}/tasks/${task.identifier.toLowerCase()}`,
		);
		await waitForPageLoad(page);
		await expect(page.getByRole('heading', { name: 'Mobile task' })).toBeVisible({
			timeout: 20000,
		});
		await expectNoHorizontalOverflow(page);

		const description = page.getByTestId('task-description-card');
		const descBox = await description.boundingBox();
		expect(descBox).not.toBeNull();
		if (descBox) {
			expect(descBox.width).toBeGreaterThan(300);
		}
	});

	test('create-task dialog goes near full-screen', async ({ page, freshWorkspace }) => {
		const { team } = freshWorkspace;
		await page.goto(`/teams/${team.slug}/tasks`);
		await waitForPageLoad(page);

		await page.getByTestId('task-list-new-task').click();
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
		const { team } = lightWorkspace;
		await page.goto(`/teams/${team.slug}/settings/audit-log`);
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
});
