// The pinned doc-list sidebar is a real-CSS-layout assertion (testing decision
// tree, point 1): it depends on `position: sticky` resolving against the shell
// scroller and the element's box moving (or not) on scroll — values happy-dom
// can't compute. So this lives in Playwright rather than a component test.

import { expect, test } from './fixtures';
import { waitForPageLoad } from './helpers';

test('documents sidebar stays pinned while the page scrolls on desktop', async ({
	page,
	freshWorkspace,
}) => {
	const { projectSlug, token } = freshWorkspace;
	// Desktop: clears md (sidebar visible) and lg (full rail + project sidebar).
	await page.setViewportSize({ width: 1280, height: 800 });

	// Seed a doc tall enough that the content column overflows the viewport, so
	// reaching the bottom requires scrolling the shell <main>.
	const longContent = `# Long document\n\n${Array.from(
		{ length: 150 },
		(_, i) => `## Section ${i}\n\nParagraph body for section ${i}.`,
	).join('\n\n')}`;
	const res = await page.request.put(`/api/projects/${projectSlug}/docs/longdoc.md`, {
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		data: { content: longContent },
	});
	expect(res.ok()).toBe(true);

	await page.goto(`/projects/${projectSlug}/documents?file=longdoc.md`);
	await waitForPageLoad(page);

	// The filename heading confirms the doc loaded and its content is rendered.
	await expect(page.getByRole('heading', { name: 'longdoc.md' })).toBeVisible({ timeout: 20000 });

	const newDocButton = page.getByRole('button', { name: /New document/ });
	await expect(newDocButton).toBeVisible();
	const before = await newDocButton.boundingBox();
	expect(before).not.toBeNull();

	// Scroll the shell scroller to the bottom.
	const scroller = page.locator('main').first();
	await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
	const scrollTop = await scroller.evaluate((el) => el.scrollTop);
	// Proves the content genuinely overflowed and we scrolled a meaningful amount.
	expect(scrollTop).toBeGreaterThan(300);

	// The sidebar button is still near the top of the viewport (pinned). Without
	// sticky it would be far above the fold (y << 0) after scrolling thousands of px.
	const after = await newDocButton.boundingBox();
	expect(after).not.toBeNull();
	if (before && after) {
		expect(after.y).toBeGreaterThanOrEqual(0);
		// Pinned: it did not drift down from its starting position.
		expect(after.y).toBeLessThanOrEqual(before.y + 1);
		// And it did not drift up either. The sticky offset mirrors the project
		// layout's vertical padding so the breathing room above the button when
		// unscrolled is preserved when the sidebar sticks; without it the button
		// would slide flush against the app header.
		expect(after.y).toBeGreaterThanOrEqual(before.y - 1);
		// And it sits within the app header + a small offset of the top.
		expect(after.y).toBeLessThan(120);
	}
});
