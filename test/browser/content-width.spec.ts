// The content-well width is a real-CSS-layout assertion (testing decision
// tree, point 1): the well's measured width comes from the flex layout pass
// against a wide viewport, which happy-dom can't compute.

import { expect, test } from './fixtures';
import { waitForPageLoad } from './helpers';

test('left nav + content spans the viewport on a wide screen', async ({ page, freshWorkspace }) => {
	await page.setViewportSize({ width: 1700, height: 900 });

	await page.goto(`/projects/${freshWorkspace.projectSlug}/tasks`);
	await waitForPageLoad(page);

	// The project sidebar only mounts at lg+ (1700px clears that); its presence
	// confirms the well holds the full rail + sidebar + content layout.
	await expect(page.getByTestId('project-sidebar-name')).toBeVisible({ timeout: 20000 });

	const box = await page.getByTestId('content-well').boundingBox();
	expect(box).not.toBeNull();
	if (box) {
		// Full viewport width (±1px for sub-pixel rounding).
		expect(box.width).toBeGreaterThanOrEqual(1699);
		expect(box.width).toBeLessThanOrEqual(1701);
		expect(box.x).toBeLessThanOrEqual(1);
	}
});
