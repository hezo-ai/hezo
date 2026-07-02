// Viewport fit is a real-CSS-layout assertion (testing decision tree, point 1):
// it compares the shell scroller's scrollWidth/clientWidth and the table
// wrapper's internal overflow after a real layout pass — happy-dom computes
// neither.

import { expect, test } from './fixtures';
import { waitForPageLoad } from './helpers';

// The three content shapes that can widen a doc past the pane: a table whose
// unbreakable code cells far exceed the column width, a single-line code
// fence, and a long unbreakable word in a paragraph.
const WIDE_DOC = [
	'# Wide document',
	'',
	'Reference sheet: https://example.com/a-very-long-unbreakable-url-segment/that-would-otherwise-widen-the-prose-column-past-the-viewport-if-it-could-not-wrap',
	'',
	'| Metric | Endpoint | Frequency |',
	'| --- | --- | --- |',
	'| Release downloads (per release, per platform) | `GET /repos/hezo-ai/hezo/releases/assets/deeply/nested/unbreakable/path` → `.assets[].download_count_with_a_long_property_name` | Per-release + weekly rollup |',
	// Underscore-only token: unlike slashes/hyphens, underscores offer no
	// line-break opportunity, so this cell's min-content width (~1000px)
	// genuinely exceeds the doc pane at every viewport under test.
	'| Star → download conversion | `total_downloads_divided_by_stargazers_count_as_one_underscored_token_that_offers_no_line_break_opportunity_at_all_and_therefore_exceeds_any_reasonable_pane_width` | Weekly |',
	'',
	'```sh',
	'curl -sS https://api.github.com/repos/hezo-ai/hezo/releases | jq ".[] | {tag_name, assets: [.assets[] | {name, download_count}]}" # one long line that must scroll inside the pre block, not widen the page',
	'```',
].join('\n');

test('documents page fits the viewport with wide doc content (desktop + mobile)', async ({
	page,
	lightWorkspace,
}) => {
	const { projectSlug, token } = lightWorkspace;
	// Desktop: clears md (doc list beside the content pane) and lg (full rail +
	// project sidebar), so the pane gets its narrowest desktop width.
	await page.setViewportSize({ width: 1280, height: 800 });

	const res = await page.request.put(`/api/projects/${projectSlug}/docs/wide.md`, {
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		data: { content: WIDE_DOC },
	});
	expect(res.ok()).toBe(true);

	await page.goto(`/projects/${projectSlug}/documents?file=wide.md`);
	await waitForPageLoad(page);
	await expect(page.getByRole('heading', { name: 'wide.md' })).toBeVisible({ timeout: 20000 });

	// The shell <main> is the only scroller; wide doc content must not give it
	// horizontal overflow (±1px for sub-pixel rounding)…
	const scroller = page.locator('main').first();
	expect(await scroller.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);

	// …so trying to side-scroll is a no-op and the doc list stays in view.
	await scroller.evaluate((el) => el.scrollTo({ left: el.scrollWidth }));
	expect(await scroller.evaluate((el) => el.scrollLeft)).toBeLessThanOrEqual(1);
	const newDocButton = page.getByRole('button', { name: /New document/ });
	await expect(newDocButton).toBeVisible();
	const listBox = await newDocButton.boundingBox();
	expect(listBox).not.toBeNull();
	if (listBox) {
		expect(listBox.x).toBeGreaterThanOrEqual(0);
	}

	// The wide table is preserved, not clipped: it scrolls inside its own
	// wrapper instead of widening the page.
	const tableWrapper = page.locator('main div.overflow-x-auto:has(> table)').first();
	await expect(tableWrapper).toBeVisible();
	expect(await tableWrapper.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeGreaterThan(50);

	// Mobile: the doc pane replaces the list at <md; the same wide content must
	// not widen the page there either.
	await page.setViewportSize({ width: 375, height: 800 });
	await expect(page.getByRole('heading', { name: 'wide.md' })).toBeVisible();
	expect(await scroller.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
});
