// Decision-tree items 1-2: a touch target is real CSS layout. The 44px floor
// exists only once Chromium evaluates the `:where([data-density="touch"])`
// ancestor rule against a laid-out box, which happy-dom neither lays out nor
// evaluates. This is also the one check that the variant literal reached the
// shipped stylesheet at all: a typo in the class string passes every unit test
// and renders nothing.
import { expect, test } from './fixtures';
import { waitForStableBox } from './helpers';

test.describe('touch density', () => {
	test('one attribute on <html> lifts a stacked control to a 44px target', async ({
		authedPage: page,
	}) => {
		await page.goto('/settings/appearance');

		// A segmented control is the stacked case a pseudo-element cannot cover,
		// and the theme picker is on a page that needs no seeded data.
		const segment = page.getByTestId('appearance-theme-control').getByRole('button').first();
		await expect(segment).toBeVisible({ timeout: 15000 });

		// Desktop density is the default: the app never opts in on its own.
		const before = await waitForStableBox(segment);
		expect(before.height).toBeLessThan(44);

		await page.evaluate(() => {
			document.documentElement.dataset.density = 'touch';
		});

		const after = await waitForStableBox(segment);
		expect(after.height).toBeGreaterThanOrEqual(44);

		// Nothing else about the control moved: the floor grows the box, not the
		// segment's place in the row.
		expect(after.x).toBe(before.x);
		expect(after.width).toBe(before.width);
	});
});
