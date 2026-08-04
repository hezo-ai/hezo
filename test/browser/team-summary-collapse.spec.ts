// Criteria #1 and #2 (real CSS layout + viewport-conditional behavior): the
// collapse assertion is a clientHeight comparison before and after the toggle,
// run at both 375px and 1280px. happy-dom returns 0 for clientHeight and runs no
// media queries, so neither half survives a component test.
import { expect, test } from './fixtures';

test.describe('team summary collapse', () => {
	for (const viewport of [
		{ name: 'mobile', width: 375, height: 800 },
		{ name: 'desktop', width: 1280, height: 800 },
	]) {
		test(`collapses by default and expands on toggle (${viewport.name})`, async ({
			page,
			freshWorkspace,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height });
			const { projectSlug } = freshWorkspace;

			await page.goto(`/projects/${projectSlug}/agents`);

			const summaryBox = page.getByTestId('team-summary');
			await expect(summaryBox).toBeVisible({ timeout: 15000 });

			const toggle = summaryBox.getByRole('button', { name: /expand|collapse/i });
			await expect(toggle).toBeVisible({ timeout: 5000 });
			await expect(toggle).toHaveAttribute('aria-expanded', 'false');

			const collapsedHeight = await summaryBox.evaluate((el) => el.clientHeight);

			await toggle.click();
			await expect(toggle).toHaveAttribute('aria-expanded', 'true');

			const expandedHeight = await summaryBox.evaluate((el) => el.clientHeight);
			expect(expandedHeight).toBeGreaterThan(collapsedHeight);

			await toggle.click();
			await expect(toggle).toHaveAttribute('aria-expanded', 'false');
		});
	}
});
