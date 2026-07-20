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

	const newDocButton = page.getByRole('button', { name: 'New document' });
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
		// It pins near the top with the sticky offset holding it just below the app
		// header (not flush against it). The page's "Documents" section header sits
		// above the two-pane and scrolls away, so the pinned sidebar ends up higher
		// than its unscrolled start — hence we bound the pinned position absolutely
		// rather than against `before.y`.
		expect(after.y).toBeLessThan(120);
	}
});

test('sidebar search header stays fixed while the doc list itself scrolls', async ({
	page,
	freshWorkspace,
}) => {
	const { projectSlug, token } = freshWorkspace;
	await page.setViewportSize({ width: 1280, height: 800 });

	// Seed enough docs that the sidebar list overflows its own md scroller
	// (max-h ≈ viewport minus header), so scrolling to the last entry scrolls
	// the list — not the page.
	const count = 40;
	for (let i = 0; i < count; i++) {
		const res = await page.request.put(
			`/api/projects/${projectSlug}/docs/doc-${String(i).padStart(2, '0')}.md`,
			{
				headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
				data: { content: `Doc ${i}` },
			},
		);
		expect(res.ok()).toBe(true);
	}

	await page.goto(`/projects/${projectSlug}/documents`);
	await waitForPageLoad(page);

	const searchInput = page.getByRole('searchbox', { name: 'Filter documents' });
	await expect(searchInput).toBeVisible();
	await expect(page.getByText('doc-00.md')).toBeVisible();

	const before = await searchInput.boundingBox();
	expect(before).not.toBeNull();

	// Scroll the list's own overflow-y-auto container to the bottom — the "doc
	// list itself scrolls" case. Scrolling this inner scroller directly (rather
	// than scrollIntoView, which can bubble to the shell <main> once the page's
	// section header pushes the list below the fold) isolates the invariant under
	// test: the search header lives above this scroller and must not move.
	const listScroller = page.getByTestId('doc-list-scroller');
	await listScroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
	await expect(page.getByText(`doc-${count - 1}.md`)).toBeVisible();

	// The search header did not move: it lives above the list's scroller.
	const after = await searchInput.boundingBox();
	expect(after).not.toBeNull();
	if (before && after) {
		expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
	}
});
