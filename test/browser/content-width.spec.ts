// The content-well width cap is a real-CSS-layout assertion (testing decision
// tree, point 1): the well's measured width comes from the flex layout pass +
// `max-width` resolving against a wide viewport, which happy-dom can't compute.

import { expect, test } from './fixtures';
import { waitForPageLoad } from './helpers';

test('left nav + content stays capped at 1280px on a wide viewport', async ({
	page,
	freshWorkspace,
}) => {
	// Far wider than the 1280px cap so a measured width at the cap proves the
	// constraint fired rather than the well merely fitting a narrow viewport.
	await page.setViewportSize({ width: 1700, height: 900 });

	await page.goto(`/projects/${freshWorkspace.projectSlug}/tasks`);
	await waitForPageLoad(page);

	// The project sidebar only mounts at lg+ (1700px clears that); its presence
	// confirms the well holds the full rail + sidebar + content layout.
	await expect(page.getByTestId('project-sidebar-name')).toBeVisible({ timeout: 20000 });

	const box = await page.getByTestId('content-well').boundingBox();
	expect(box).not.toBeNull();
	if (box) {
		// Capped at 1280 (+1px for sub-pixel rounding) and actually near the cap.
		expect(box.width).toBeLessThanOrEqual(1281);
		expect(box.width).toBeGreaterThanOrEqual(1279);
		// Left-aligned against the viewport edge, with empty space to the right.
		expect(box.x).toBeLessThanOrEqual(1);
		expect(box.x + box.width).toBeLessThan(1700);
	}
});
