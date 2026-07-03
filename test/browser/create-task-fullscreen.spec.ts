// Decision-tree item 1: the fullscreen toggle grows the description textarea to
// fill the panel via a flex chain (`flex-1` + `min-h-0`). Asserting the box
// actually grows reads real `clientHeight` off a live layout pass, which
// happy-dom can't resolve — the component tier only covers the toggle's state.
import { expect, test } from './fixtures';
import { createProjectAndClearPlanning, uniqueName, waitForPageLoad } from './helpers';

test('the create-task dialog fullscreen toggle grows the description to fill the panel', async ({
	sharedPage: page,
	sharedWorkspace,
}) => {
	const { token } = sharedWorkspace;
	const project = await createProjectAndClearPlanning(page, '', token, {
		name: uniqueName('Fullscreen Task'),
		description: 'E2E create-task fullscreen toggle.',
	});

	// Desktop viewport — the toggle is `sm:block`, hidden on mobile where the
	// dialog is already near-full-screen.
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto(`/projects/${project.slug}/tasks`);
	await waitForPageLoad(page);

	await page.getByTestId('project-sidebar-new-task').click();
	await expect(page.getByRole('heading', { name: 'Create Task' })).toBeVisible();

	const description = page.getByLabel('Description', { exact: true });
	await expect(description).toBeVisible();
	const beforeHeight = await description.evaluate((el) => el.clientHeight);

	// Enter fullscreen: the panel fills the viewport and the description flexes
	// to take the freed space.
	const toggle = page.getByTestId('create-task-fullscreen');
	await expect(toggle).toHaveAttribute('aria-label', 'Enter fullscreen');
	await toggle.click();
	await expect(toggle).toHaveAttribute('aria-label', 'Exit fullscreen');

	await expect
		.poll(async () => description.evaluate((el) => el.clientHeight))
		.toBeGreaterThan(beforeHeight + 150);

	// The textarea should now occupy the bulk of the dialog's height.
	const content = page.locator('[data-fullscreen="true"]');
	const descBox = await description.boundingBox();
	const contentBox = await content.boundingBox();
	if (!descBox || !contentBox) throw new Error('Missing layout box');
	expect(descBox.height).toBeGreaterThan(contentBox.height * 0.4);

	// Collapsing restores the compact size.
	await toggle.click();
	await expect(toggle).toHaveAttribute('aria-label', 'Enter fullscreen');
	await expect
		.poll(async () => description.evaluate((el) => el.clientHeight))
		.toBeLessThan(beforeHeight + 100);
});
