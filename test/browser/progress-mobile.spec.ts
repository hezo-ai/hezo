import { expect, test } from './fixtures';
import { createProjectAndClearPlanning, uniqueName, waitForPageLoad } from './helpers';

// Playwright, not a component test: the Progress page's three columns are viewport-conditional
// (Tailwind `md:` swaps a tab strip for a 3-column grid). happy-dom runs no media queries against
// a real layout pass, so both branches sit in its DOM at once and it cannot tell you which one a
// phone actually shows — decision-tree rule 2. The column *contents* are covered in the component
// tier; this spec is purely about which layout a given viewport gets.

const MOBILE = { width: 375, height: 800 };
const DESKTOP = { width: 1280, height: 900 };

test.describe('Progress page at mobile width', () => {
	test('shows one tabbed panel on a phone and three columns on desktop', async ({
		page,
		sharedWorkspace,
	}) => {
		const project = await createProjectAndClearPlanning(
			page,
			sharedWorkspace.teamSlug,
			sharedWorkspace.token,
			{ name: uniqueName('Progress Mobile') },
		);

		await page.setViewportSize(MOBILE);
		await page.goto(`/projects/${project.slug}/progress`);
		await waitForPageLoad(page);

		// Mobile: the tab strip is the only way the three groups are reachable, and the desktop
		// grid must not be laid out at all.
		const actionedTab = page.getByTestId('progress-tab-actioned');
		const closedTab = page.getByTestId('progress-tab-closed');
		await expect(actionedTab).toBeVisible();
		await expect(closedTab).toBeVisible();
		await expect(page.getByTestId('progress-column-actioned')).toBeHidden();

		// Exactly one panel is on screen, so an empty project shows the explanation once rather
		// than three times over. Filtered to visible on purpose: the desktop grid is `hidden
		// md:grid`, so its three columns stay in the DOM at this width and a bare `toHaveCount`
		// would count them.
		const visibleEmpty = page.getByTestId('progress-column-empty').filter({ visible: true });
		await expect(visibleEmpty).toHaveCount(1);

		// Tapping a tab keeps that single-panel shape.
		await closedTab.click();
		await expect(visibleEmpty).toHaveCount(1);

		// Tap targets stay thumb-sized.
		const box = await actionedTab.boundingBox();
		expect(box?.height ?? 0).toBeGreaterThanOrEqual(32);

		// The page never scrolls sideways at phone width.
		const overflows = await page.evaluate(
			() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
		);
		expect(overflows).toBe(false);

		// Desktop: the grid takes over and the tab strip goes away.
		await page.setViewportSize(DESKTOP);
		await expect(page.getByTestId('progress-column-actioned')).toBeVisible();
		await expect(page.getByTestId('progress-column-created')).toBeVisible();
		await expect(page.getByTestId('progress-column-closed')).toBeVisible();
		await expect(actionedTab).toBeHidden();
	});

	test('the summary, goal indicator and runs list all fit a phone', async ({
		page,
		sharedWorkspace,
	}) => {
		const project = await createProjectAndClearPlanning(
			page,
			sharedWorkspace.teamSlug,
			sharedWorkspace.token,
			{ name: uniqueName('Progress Mobile Chrome') },
		);

		await page.setViewportSize(MOBILE);
		await page.goto(`/projects/${project.slug}/progress`);
		await waitForPageLoad(page);

		await expect(page.getByTestId('project-progress-summary')).toBeVisible();
		// With no goals the indicator is the nudge to set the first one, and it links to Goals.
		const indicator = page.getByTestId('goal-progress-indicator-empty');
		await expect(indicator).toBeVisible();
		await expect(indicator).toHaveAttribute('href', `/projects/${project.slug}/progress/goals`);
		await expect(page.getByTestId('progress-updates')).toBeVisible();

		// Following it lands on the nested Goals route, breadcrumb and all.
		await indicator.click();
		await expect(page).toHaveURL(new RegExp(`/projects/${project.slug}/progress/goals$`));
		await expect(page.getByTestId('goals-breadcrumb')).toBeVisible();
	});
});
