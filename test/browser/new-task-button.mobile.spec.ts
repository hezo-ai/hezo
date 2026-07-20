// Decision-tree items 1–2: the header new-task button is viewport-conditional
// (`lg:hidden`) and the desktop equivalent is the sidebar "+", which only shows
// once the persistent menu renders at ≥1024. happy-dom can't run the media
// queries or report real layout positions, so this needs real Chromium +
// setViewportSize.
import { expect, test } from './fixtures';
import { createProjectAndClearPlanning, uniqueName, waitForPageLoad } from './helpers';

test.describe('Header new-task button responsiveness', () => {
	test('mobile shows the header "+" left of search; desktop hides it for the sidebar "+"', async ({
		page,
		sharedWorkspace,
	}) => {
		const { token } = sharedWorkspace;
		const project = await createProjectAndClearPlanning(page, '', token, {
			name: uniqueName('Header Task'),
			description: 'E2E header new-task button.',
		});

		// --- Mobile: header button visible, leftmost in the top-right action group. ---
		await page.setViewportSize({ width: 375, height: 800 });
		await page.goto(`/projects/${project.slug}/tasks`);
		await waitForPageLoad(page);

		const headerButton = page.getByTestId('app-header-new-task');
		await expect(headerButton).toBeVisible({ timeout: 15000 });
		const buttonBox = await headerButton.boundingBox();
		const searchBox = await page.getByTestId('app-header-search').boundingBox();
		const headerBox = await page.getByTestId('app-header').boundingBox();
		if (!buttonBox || !searchBox || !headerBox) throw new Error('Missing layout box');
		// Inside the top nav bar, directly to the left of the search button.
		expect(buttonBox.y).toBeGreaterThanOrEqual(headerBox.y);
		expect(buttonBox.y + buttonBox.height).toBeLessThanOrEqual(headerBox.y + headerBox.height + 1);
		expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(searchBox.x + 1);
		expect(Math.abs(buttonBox.y - searchBox.y)).toBeLessThan(buttonBox.height);

		// Quiet, outlined treatment: the button fill is transparent (matching the
		// other nav icons) with a primary-red bordered "+" box marking the create
		// action — not the old solid-accent fill.
		const background = await headerButton.evaluate((el) => getComputedStyle(el).backgroundColor);
		expect(background).toBe('rgba(0, 0, 0, 0)');
		const borderColor = await headerButton.evaluate((el) => {
			const box = el.querySelector('span');
			return box ? getComputedStyle(box).borderTopColor : '';
		});
		expect(borderColor).not.toBe('rgba(0, 0, 0, 0)');

		// Opening it pops the create-task dialog with the current project preselected.
		await headerButton.click();
		await expect(page.getByRole('heading', { name: 'Create Task' })).toBeVisible();
		await expect(page.getByTestId('create-task-project')).toHaveValue(project.slug);
		await page.keyboard.press('Escape');
		await expect(page.getByRole('heading', { name: 'Create Task' })).toBeHidden();

		// --- Desktop: header button is gone; the sidebar carries the "+". ---
		await page.setViewportSize({ width: 1280, height: 900 });
		await expect(headerButton).toBeHidden();
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

		// --- Desktop: the persistent menu shows both chips. Scope to the persistent
		// sidebar (content-well): the drawer opened above stays mounted (just
		// `lg:hidden`), so the project menu — and its chips' testids — exist twice. ---
		await page.setViewportSize({ width: 1280, height: 900 });
		const persistentMenu = page.getByTestId('content-well');
		await expect(persistentMenu.getByTestId('project-sidebar-new-task')).toBeVisible();
		await expect(persistentMenu.getByRole('button', { name: 'Hire a new agent' })).toBeVisible();
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

	// The create button's "New task" label is `hidden lg:inline` — a real
	// media-query/layout assertion (decision-tree items 1–2), so it needs
	// Chromium + setViewportSize; happy-dom can't resolve the breakpoint.
	test('the create button is icon-only on mobile and shows its label on desktop', async ({
		page,
		sharedWorkspace,
	}) => {
		const { token } = sharedWorkspace;
		const project = await createProjectAndClearPlanning(page, '', token, {
			name: uniqueName('Task Label'),
			description: 'E2E new-task label responsiveness.',
		});

		const newTask = page.getByTestId('task-list-new-task');
		// The label lives in a span; the button also carries it as aria-label/title,
		// but getByText only matches the rendered text node, so it targets the span.
		const label = newTask.getByText('New task', { exact: true });

		// Mobile: icon-only — the label span is display:none.
		await page.setViewportSize({ width: 375, height: 800 });
		await page.goto(`/projects/${project.slug}/tasks`);
		await waitForPageLoad(page);
		await expect(newTask).toBeVisible({ timeout: 15000 });
		await expect(label).toBeHidden();

		// Desktop (≥lg): the "New task" label renders beside the icon.
		await page.setViewportSize({ width: 1280, height: 900 });
		await expect(label).toBeVisible();
	});
});
