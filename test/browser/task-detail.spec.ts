import { expect, test } from './fixtures';
import { createProjectAndClearPlanning, uniqueName, waitForPageLoad } from './helpers';

type Page = import('@playwright/test').Page;

async function createProjectViaApi(
	page: Page,
	teamSlug: string,
	token: string,
	name: string,
	description: string,
): Promise<{ id: string; slug: string }> {
	const res = await createProjectAndClearPlanning(page, teamSlug, token, { name, description });
	return ((await res.json()) as { data: { id: string; slug: string } }).data;
}

async function createTaskViaApi(
	page: Page,
	projectSlug: string,
	token: string,
	data: { project_id: string; title: string; assignee_id: string; description?: string },
) {
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
	const res = await page.request.post(`/api/projects/${projectSlug}/tasks`, { headers, data });
	return (
		(await res.json()) as {
			data: { id: string; identifier: string; title: string };
		}
	).data;
}

test.describe('Task detail — right sidebar sticky positioning', () => {
	test('right sidebar floats sticky on desktop scroll and houses the Effort control while wake-assignee lives in the comment form', async ({
		page,
		sharedWorkspace,
	}) => {
		const { team, agents, token } = sharedWorkspace;
		await page.setViewportSize({ width: 1280, height: 720 });

		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
		const project = await createProjectViaApi(
			page,
			team.slug,
			token,
			uniqueName('Sidebar Project'),
			'Sidebar test project.',
		);
		const task = await createTaskViaApi(page, project.slug, token, {
			project_id: project.id,
			title: 'Sidebar Test Task',
			assignee_id: agents[0].id,
		});

		for (let i = 0; i < 25; i++) {
			await page.request.post(`/api/projects/${project.slug}/tasks/${task.id}/comments`, {
				headers,
				data: {
					content_type: 'text',
					content: { text: `Filler comment ${i}. ${'lorem ipsum '.repeat(30)}` },
				},
			});
		}

		await page.goto(`/projects/${project.slug}/tasks/${task.id}`);
		await waitForPageLoad(page);

		const sidebar = page.getByTestId('task-sidebar');
		await expect(sidebar).toBeVisible({ timeout: 20000 });

		const position = await sidebar.evaluate((el) => getComputedStyle(el).position);
		expect(position).toBe('sticky');

		const main = page.locator('main').first();
		const initialY = (await sidebar.boundingBox())?.y ?? 0;

		await main.evaluate((el) => {
			el.scrollBy(0, 800);
		});
		await page.waitForTimeout(100);

		const scrolled = await sidebar.boundingBox();
		expect(scrolled).not.toBeNull();
		expect(scrolled!.y).toBeLessThanOrEqual(initialY);
		expect(scrolled!.y).toBeGreaterThanOrEqual(0);
		expect(scrolled!.y + scrolled!.height).toBeLessThanOrEqual(720);

		const effort = sidebar.getByLabel(
			'Reasoning effort for the agent run triggered by this comment',
		);
		await expect(effort).toBeVisible();

		await expect(sidebar.getByRole('checkbox', { name: 'Wake assignee on submit' })).toHaveCount(0);
	});
});

test.describe('Task detail — initial scroll and scroll-to-bottom button', () => {
	test('lands at top of ticket page and floating button scrolls to bottom on demand', async ({
		page,
		sharedWorkspace,
	}) => {
		const { team, agents, token } = sharedWorkspace;
		await page.setViewportSize({ width: 1280, height: 720 });

		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
		const project = await createProjectViaApi(
			page,
			team.slug,
			token,
			uniqueName('Scroll Project'),
			'Scroll behavior test.',
		);
		const task = await createTaskViaApi(page, project.slug, token, {
			project_id: project.id,
			title: 'Scroll Test Task',
			assignee_id: agents[0].id,
			description: 'A short description so the page header stays compact.',
		});

		for (let i = 0; i < 30; i++) {
			await page.request.post(`/api/projects/${project.slug}/tasks/${task.id}/comments`, {
				headers,
				data: {
					content_type: 'text',
					content: { text: `Filler comment ${i}. ${'lorem ipsum '.repeat(30)}` },
				},
			});
		}

		await page.goto(`/projects/${project.slug}/tasks/${task.identifier.toLowerCase()}`);
		await waitForPageLoad(page);
		await expect(page.getByRole('heading', { name: 'Scroll Test Task' })).toBeInViewport();

		const main = page.locator('main').first();
		await expect.poll(() => main.evaluate((el) => el.scrollTop), { timeout: 10000 }).toBe(0);

		const button = page.getByTestId('task-scroll-to-bottom');
		await expect(button).toBeVisible();

		await button.click();

		await expect(button).toBeHidden({ timeout: 10000 });
		await expect(page.getByPlaceholder('Add a comment...')).toBeInViewport();
	});

	test('button is also functional at mobile viewport', async ({
		sharedPage: page,
		sharedWorkspace,
	}) => {
		const { team, agents, token } = sharedWorkspace;
		await page.setViewportSize({ width: 375, height: 720 });

		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
		const project = await createProjectViaApi(
			page,
			team.slug,
			token,
			uniqueName('Mobile Scroll Project'),
			'Mobile scroll behavior test.',
		);
		const task = await createTaskViaApi(page, project.slug, token, {
			project_id: project.id,
			title: 'Mobile Scroll Task',
			assignee_id: agents[0].id,
		});

		for (let i = 0; i < 30; i++) {
			await page.request.post(`/api/projects/${project.slug}/tasks/${task.id}/comments`, {
				headers,
				data: {
					content_type: 'text',
					content: { text: `Mobile filler ${i}. ${'lorem ipsum '.repeat(30)}` },
				},
			});
		}

		await page.goto(`/projects/${project.slug}/tasks/${task.identifier.toLowerCase()}`);
		await waitForPageLoad(page);
		await expect(page.getByRole('heading', { name: 'Mobile Scroll Task' })).toBeInViewport();

		const main = page.locator('main').first();
		await expect.poll(() => main.evaluate((el) => el.scrollTop), { timeout: 10000 }).toBe(0);

		const button = page.getByTestId('task-scroll-to-bottom');
		await expect(button).toBeVisible();
		await button.click();

		await expect(button).toBeHidden({ timeout: 10000 });
		await expect(page.getByPlaceholder('Add a comment...')).toBeInViewport();
	});
});
