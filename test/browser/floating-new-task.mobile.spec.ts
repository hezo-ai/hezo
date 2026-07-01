// Decision-tree items 1–2: the floating new-task button is viewport-conditional
// (`lg:hidden`, pinned bottom-left via `fixed`) and the desktop equivalent is the
// sidebar "+", which only shows once the persistent menu renders at ≥1024.
// happy-dom can't run the media queries or report fixed-position layout, so this
// needs real Chromium + setViewportSize.
import { expect, test } from './fixtures';
import { createProjectAndClearPlanning, uniqueName, waitForPageLoad } from './helpers';

test.describe('Floating new-task button responsiveness', () => {
	test('mobile shows the floating "+" bottom-left; desktop hides it for the sidebar "+"', async ({
		page,
		sharedWorkspace,
	}) => {
		const { token } = sharedWorkspace;
		const project = await createProjectAndClearPlanning(page, '', token, {
			name: uniqueName('Floating Task'),
			description: 'E2E floating new-task button.',
		});

		// --- Mobile: floating button visible and pinned to the bottom-left corner. ---
		await page.setViewportSize({ width: 375, height: 800 });
		await page.goto(`/projects/${project.slug}/tasks`);
		await waitForPageLoad(page);

		const floating = page.getByTestId('floating-new-task');
		await expect(floating).toBeVisible({ timeout: 15000 });
		const box = await floating.boundingBox();
		const viewport = page.viewportSize();
		if (!box || !viewport) throw new Error('Missing layout box');
		// Anchored to the left half and near the bottom of the viewport.
		expect(box.x).toBeLessThan(viewport.width / 2);
		expect(box.y).toBeGreaterThan(viewport.height / 2);

		// Opening it pops the create-task dialog…
		await floating.click();
		await expect(page.getByRole('heading', { name: 'Create Task' })).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(page.getByRole('heading', { name: 'Create Task' })).toBeHidden();

		// …and it hides while the mobile nav drawer is open.
		await page.getByTestId('mobile-nav-toggle').click();
		await expect(page.getByTestId('mobile-nav-drawer')).toBeVisible();
		await expect(floating).toBeHidden();
		// No close button — clicking the background overlay (right of the panel) dismisses it.
		await page
			.getByTestId('mobile-nav-drawer')
			.getByRole('button', { name: 'Close navigation' })
			.click({
				position: { x: 350, y: 400 },
			});
		await expect(floating).toBeVisible();

		// …and it hides while the CEO chat is open.
		await page.getByTestId('ceo-chat-launcher').click();
		await expect(page.getByTestId('ceo-chat-panel')).toBeVisible();
		await expect(floating).toBeHidden();
		await page.getByTestId('ceo-chat-close').click();
		await expect(floating).toBeVisible();

		// --- Desktop: floating button is gone; the sidebar carries the "+". ---
		await page.setViewportSize({ width: 1280, height: 900 });
		await expect(floating).toBeHidden();
		const sidebarPlus = page.getByTestId('project-sidebar-new-task');
		await expect(sidebarPlus).toBeVisible();
		await sidebarPlus.click();
		await expect(page.getByRole('heading', { name: 'Create Task' })).toBeVisible();
	});

	test('project-menu "+" chips (Tasks, Team) are hidden on mobile, shown on desktop', async ({
		page,
		sharedWorkspace,
	}) => {
		const { token } = sharedWorkspace;
		const project = await createProjectAndClearPlanning(page, '', token, {
			name: uniqueName('Menu Plus'),
			description: 'E2E project-menu plus chips.',
		});

		// --- Mobile: open the nav drawer; the "+" chips are too easy to fat-finger,
		// so they're `hidden md:inline-flex` — present in the DOM but not visible. ---
		await page.setViewportSize({ width: 375, height: 800 });
		await page.goto(`/projects/${project.slug}/tasks`);
		await waitForPageLoad(page);

		await page.getByTestId('mobile-nav-toggle').click();
		const drawer = page.getByTestId('mobile-nav-drawer');
		await expect(drawer).toBeVisible();
		await expect(drawer.getByTestId('project-sidebar-new-task')).toBeHidden();
		await expect(drawer.getByRole('button', { name: 'Hire a new agent' })).toBeHidden();

		// --- Desktop: the persistent menu shows both chips. ---
		await page.setViewportSize({ width: 1280, height: 900 });
		await expect(page.getByTestId('project-sidebar-new-task')).toBeVisible();
		await expect(page.getByRole('button', { name: 'Hire a new agent' })).toBeVisible();
	});

	test('the filter bar and its icon create button share one row on mobile', async ({
		page,
		sharedWorkspace,
	}) => {
		const { token } = sharedWorkspace;
		const project = await createProjectAndClearPlanning(page, '', token, {
			name: uniqueName('Filter Row'),
			description: 'E2E filter bar row.',
		});

		await page.setViewportSize({ width: 375, height: 800 });
		await page.goto(`/projects/${project.slug}/tasks`);
		await waitForPageLoad(page);

		const bar = page.getByTestId('task-filter-bar');
		const newTask = page.getByTestId('task-list-new-task');
		await expect(bar).toBeVisible({ timeout: 15000 });
		await expect(newTask).toBeVisible();

		const barBox = await bar.boundingBox();
		const btnBox = await newTask.boundingBox();
		if (!barBox || !btnBox) throw new Error('Missing layout box');
		// Same row: vertically overlapping, with the button to the right of the bar.
		expect(btnBox.x).toBeGreaterThan(barBox.x + barBox.width - 4);
		expect(Math.abs(btnBox.y - barBox.y)).toBeLessThan(barBox.height);
	});
});
