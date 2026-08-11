// Criterion #1 (real CSS layout): the assertions here are scroll and position
// measurements - `toBeInViewport` after a scroll-to-bottom, and a boundingBox
// centre comparison proving the scroll pills centre over the content column
// rather than over content + the sticky meta rail. happy-dom lays nothing out, so
// all of it would read 0. Per-test rationale is inline below.
import { expect, test } from './fixtures';
import { createProjectAndClearPlanning, uniqueName, waitForPageLoad } from './helpers';

type Page = import('@playwright/test').Page;

async function createProjectViaApi(
	page: Page,
	token: string,
	name: string,
	description: string,
): Promise<{ id: string; slug: string; assigneeId: string }> {
	const res = await createProjectAndClearPlanning(page, '', token, { name, description });
	const project = ((await res.json()) as { data: { id: string; slug: string } }).data;
	const agentsRes = await page.request.get(`/api/projects/${project.slug}/agents`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const assigneeId = (agents.find((a) => a.slug === 'captain') ?? agents[0]).id;
	return { ...project, assigneeId };
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
		const { token } = sharedWorkspace;
		await page.setViewportSize({ width: 1280, height: 720 });

		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
		const project = await createProjectViaApi(
			page,
			token,
			uniqueName('Sidebar Project'),
			'Sidebar test project.',
		);
		const task = await createTaskViaApi(page, project.slug, token, {
			project_id: project.id,
			title: 'Sidebar Test Task',
			assignee_id: project.assigneeId,
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

		// On desktop the rail is an in-grid sticky column — the mobile floating
		// toggle (`lg:hidden`) must not be present.
		await expect(page.getByTestId('task-sidebar-toggle')).toBeHidden();

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
		// Top spacing stays put: the sticky offset mirrors the project layout's
		// vertical padding, so the sidebar keeps its breathing room below the app
		// header instead of sliding flush against it. Without the padding in the
		// sticky `top`, scrolled.y would drop by ~24px (the lg:py-6 gap).
		expect(scrolled!.y).toBeGreaterThanOrEqual(initialY - 1);

		const effort = sidebar.getByLabel(
			'Reasoning effort for the agent run triggered by this comment',
		);
		await expect(effort).toBeVisible();

		// The wake preview lives in the comment composer, not the sidebar.
		await expect(sidebar.getByTestId('wake-preview')).toHaveCount(0);
		await expect(page.getByTestId('wake-preview')).toBeVisible();
	});
});

test.describe('Task detail — initial scroll and scroll-to-bottom button', () => {
	test('lands at top of task page and floating button scrolls to bottom on demand', async ({
		page,
		sharedWorkspace,
	}) => {
		const { token } = sharedWorkspace;
		await page.setViewportSize({ width: 1280, height: 720 });

		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
		const project = await createProjectViaApi(
			page,
			token,
			uniqueName('Scroll Project'),
			'Scroll behavior test.',
		);
		const task = await createTaskViaApi(page, project.slug, token, {
			project_id: project.id,
			title: 'Scroll Test Task',
			assignee_id: project.assigneeId,
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

		const button = page.getByTestId('scroll-to-bottom');
		// Landing at the top: the pill only surfaces once the reader scrolls down.
		await expect(button).toBeHidden();
		await main.evaluate((el) => el.scrollBy({ top: 400 }));
		await expect(button).toBeVisible();

		await button.click();

		await expect(button).toBeHidden({ timeout: 10000 });
		await expect(page.getByPlaceholder('Add a comment...')).toBeInViewport();
	});

	test('button is also functional at mobile viewport', async ({
		sharedPage: page,
		sharedWorkspace,
	}) => {
		const { token } = sharedWorkspace;
		await page.setViewportSize({ width: 375, height: 720 });

		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
		const project = await createProjectViaApi(
			page,
			token,
			uniqueName('Mobile Scroll Project'),
			'Mobile scroll behavior test.',
		);
		const task = await createTaskViaApi(page, project.slug, token, {
			project_id: project.id,
			title: 'Mobile Scroll Task',
			assignee_id: project.assigneeId,
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

		// The same global pill pinned bottom-centre of the content area, clear of
		// the CEO chat launcher in the corner. It surfaces once the reader scrolls
		// down rather than sitting there permanently.
		const button = page.getByTestId('scroll-to-bottom');
		await expect(button).toBeHidden();
		await main.evaluate((el) => el.scrollBy({ top: 400 }));
		await expect(button).toBeVisible();
		await button.click();

		await expect(button).toBeHidden({ timeout: 10000 });
		await expect(page.getByPlaceholder('Add a comment...')).toBeInViewport();
	});

	// boundingBox() centre comparison (testing decision tree, point 1): at lg+ the
	// task <main> holds a two-column grid (content column + sticky meta rail). The
	// global scroll pills must centre over the scrolled *content* column, not over
	// content + the non-scrolling rail — which would drift them right, over the
	// rail. Both pills read the same `--pill-center-x`, so proving the down pill is
	// centred proves the mechanism.
	test('scroll pill centres over the content column, not the content + side panel', async ({
		page,
		sharedWorkspace,
	}) => {
		const { token } = sharedWorkspace;
		// Wide enough that the lg+ meta rail reserves a real right column.
		await page.setViewportSize({ width: 1440, height: 900 });

		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
		const project = await createProjectViaApi(
			page,
			token,
			uniqueName('Pill Centre Project'),
			'Pill centring test.',
		);
		const task = await createTaskViaApi(page, project.slug, token, {
			project_id: project.id,
			title: 'Pill Centre Task',
			assignee_id: project.assigneeId,
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
		await expect(page.getByRole('heading', { name: 'Pill Centre Task' })).toBeInViewport();

		const main = page.locator('main').first();
		const button = page.getByTestId('scroll-to-bottom');
		// The sticky meta rail must actually reserve a right column at this width.
		await expect(page.getByTestId('task-rail')).toBeVisible();

		// Reveal the pill with a downward scroll.
		await main.evaluate((el) => el.scrollBy({ top: 400 }));
		await expect(button).toBeVisible();

		const contentBox = await page.getByTestId('task-content').boundingBox();
		const pillBox = await button.boundingBox();
		const mainBox = await main.boundingBox();
		expect(contentBox).not.toBeNull();
		expect(pillBox).not.toBeNull();
		expect(mainBox).not.toBeNull();
		if (contentBox && pillBox && mainBox) {
			const pillCentre = pillBox.x + pillBox.width / 2;
			const contentCentre = contentBox.x + contentBox.width / 2;
			const mainCentre = mainBox.x + mainBox.width / 2;
			// The pill centres over the content column…
			expect(Math.abs(pillCentre - contentCentre)).toBeLessThan(3);
			// …and that is meaningfully left of the full <main> centre (proving it is
			// not centred over content + the reserved side-panel column).
			expect(pillCentre).toBeLessThan(mainCentre - 100);
		}
	});
});
