// Real-CSS-layout + scroll-position assertions (testing decision tree, point 1):
// the floating document-action header depends on `position: sticky` resolving
// against the shell <main> scroller and its box staying put on scroll, and the
// count-chip jump depends on `scrollIntoView` actually moving the viewport onto
// the highlight — values happy-dom can't compute. So this lives in Playwright.
// The chip-click wiring itself is covered in packages/web/test/document-review.test.tsx.

import { expect, test } from './fixtures';
import { waitForPageLoad } from './helpers';

const DOC = 'sticky-actions.md';

// A document long enough that its content column overflows the viewport, so
// reaching the bottom requires scrolling the shell <main>.
const LONG_CONTENT = `# Long document\n\n${Array.from(
	{ length: 150 },
	(_, i) => `## Section ${i}\n\nParagraph body for section ${i}.`,
).join('\n\n')}`;

async function seedDoc(
	page: import('@playwright/test').Page,
	projectSlug: string,
	token: string,
	content: string,
): Promise<void> {
	const res = await page.request.put(`/api/projects/${projectSlug}/docs/${DOC}`, {
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		data: { content },
	});
	expect(res.ok()).toBe(true);
}

async function seedComment(
	page: import('@playwright/test').Page,
	projectSlug: string,
	token: string,
	quote: string,
): Promise<void> {
	const res = await page.request.post(`/api/projects/${projectSlug}/docs/${DOC}/review-comments`, {
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		data: { quote, occurrence: 0, comment: `Comment on ${quote}` },
	});
	expect(res.ok()).toBe(true);
}

for (const { name, width, height } of [
	{ name: 'desktop', width: 1280, height: 800 },
	{ name: 'mobile', width: 375, height: 800 },
]) {
	test(`${name}: the document actions stay pinned while the page scrolls`, async ({
		page,
		lightWorkspace,
	}) => {
		const { projectSlug, token } = lightWorkspace;
		await page.setViewportSize({ width, height });
		await seedDoc(page, projectSlug, token, LONG_CONTENT);
		// A review comment so the whole action cluster — the review toolbar plus the
		// edit/delete controls — is present in the header we expect to stay pinned.
		await seedComment(page, projectSlug, token, 'Long document');

		await page.goto(`/projects/${projectSlug}/documents?file=${DOC}`);
		await waitForPageLoad(page);
		await expect(page.getByRole('heading', { name: DOC })).toBeVisible({ timeout: 20000 });

		const editButton = page.getByRole('button', { name: 'Edit' });
		const reviewToolbar = page.getByTestId('review-toolbar');
		await expect(editButton).toBeVisible();
		await expect(reviewToolbar).toBeVisible();

		// Scroll the shell scroller to the bottom.
		const scroller = page.locator('main').first();
		await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
		const scrollTop = await scroller.evaluate((el) => el.scrollTop);
		// Proves the content genuinely overflowed and we scrolled a meaningful amount.
		expect(scrollTop).toBeGreaterThan(300);

		// The actions are still visible near the top of the viewport (pinned). Without
		// sticky they would be thousands of px above the fold (y << 0) after scrolling.
		await expect(editButton).toBeVisible();
		await expect(reviewToolbar).toBeVisible();
		const editBox = await editButton.boundingBox();
		const toolbarBox = await reviewToolbar.boundingBox();
		expect(editBox).not.toBeNull();
		expect(toolbarBox).not.toBeNull();
		if (editBox) {
			expect(editBox.y).toBeGreaterThanOrEqual(0);
			// Docked within the app header + a small offset of the top.
			expect(editBox.y).toBeLessThan(150);
		}
		if (toolbarBox) {
			expect(toolbarBox.y).toBeGreaterThanOrEqual(0);
			expect(toolbarBox.y).toBeLessThan(150);
		}
	});
}

test('clicking the review count chip scrolls the first comment into view', async ({
	page,
	lightWorkspace,
}) => {
	const { projectSlug, token } = lightWorkspace;
	await page.setViewportSize({ width: 1280, height: 800 });

	// A unique target buried below a tall block of filler, so it starts well below
	// the fold and only a real scroll can bring it into view.
	const target = 'Zulu-Jump-Target-Marker';
	const content = [
		'# Jump document',
		'',
		...Array.from({ length: 60 }, (_, i) => `Filler paragraph number ${i} to push things down.`),
		'',
		`Paragraph containing the ${target} to jump to.`,
		'',
		...Array.from({ length: 30 }, (_, i) => `Trailing filler paragraph number ${i}.`),
	].join('\n\n');
	await seedDoc(page, projectSlug, token, content);
	await seedComment(page, projectSlug, token, target);

	await page.goto(`/projects/${projectSlug}/documents?file=${DOC}`);
	await waitForPageLoad(page);
	await expect(page.getByRole('heading', { name: DOC })).toBeVisible({ timeout: 20000 });

	const mark = page.locator('mark[data-review-id]');
	await expect(mark).toHaveText(target, { timeout: 15000 });

	// The chip lives in the always-visible sticky header; the target starts off-screen.
	const chip = page.getByTestId('review-count-chip');
	await expect(chip).toBeVisible();
	await expect(mark).not.toBeInViewport();

	await chip.click();

	// Clicking the chip brings the first (here: only) comment into view.
	await expect(mark).toBeInViewport({ timeout: 10000 });
});
