// Real clientHeight/scrollHeight/scrollTop comparisons (testing decision tree,
// point 1): the global scroll-to-top pill only shows once the shell <main>
// genuinely overflows AND has been scrolled down, and clicking it must move the
// real scroll position back to the top — values happy-dom can't compute. Mirrors
// scroll-to-bottom-global.spec.ts; also asserts the pill sits below the top nav.

import { expect, test } from './fixtures';
import { waitForPageLoad } from './helpers';

const DOC = 'long-doc-top.md';

// Long enough that the content column overflows the viewport at both
// breakpoints, so reaching the bottom requires scrolling.
const LONG_CONTENT = `# Long document\n\n${Array.from(
	{ length: 150 },
	(_, i) => `## Section ${i}\n\nParagraph body for section ${i}.`,
).join('\n\n')}\n\nTHE-VERY-END`;

const SHORT_CONTENT = '# Short document\n\nJust one paragraph.';

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

for (const { name, width, height } of [
	{ name: 'desktop', width: 1280, height: 800 },
	{ name: 'mobile', width: 375, height: 800 },
]) {
	test(`${name}: pill appears once scrolled down and jumps back to the top`, async ({
		page,
		lightWorkspace,
	}) => {
		const { projectSlug, token } = lightWorkspace;
		await page.setViewportSize({ width, height });
		await seedDoc(page, projectSlug, token, LONG_CONTENT);

		await page.goto(`/projects/${projectSlug}/documents?file=${DOC}`);
		await waitForPageLoad(page);
		await expect(page.getByRole('heading', { name: DOC })).toBeVisible({ timeout: 20000 });

		const button = page.getByTestId('scroll-to-top');
		const main = page.locator('main').first();

		// At the top there is nothing to jump to, so the pill stays hidden.
		await expect(button).toBeHidden();

		// Scroll to the bottom; the pill now offers a jump back to the top.
		await main.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
		await expect(button).toBeVisible();

		// It sits just below the app header (the top nav bar), in the upper portion
		// of the viewport rather than floating mid-page.
		const headerBox = await page.getByTestId('app-header').boundingBox();
		const buttonBox = await button.boundingBox();
		expect(headerBox).not.toBeNull();
		expect(buttonBox).not.toBeNull();
		if (headerBox && buttonBox) {
			expect(buttonBox.y).toBeGreaterThanOrEqual(headerBox.y + headerBox.height - 1);
			expect(buttonBox.y).toBeLessThan(height / 2);
		}

		await button.click();

		// The pill hides once the scroller reaches the top, and the real scroll
		// position confirms the content genuinely moved back up. A *single* click
		// must land at the very top (0), not merely within the button's hide
		// threshold: the rAF-driven scroll always finishes at 0, where the old
		// native `scrollTo({ behavior: 'smooth' })` could stall partway on mobile
		// and need a second tap.
		await expect(button).toBeHidden({ timeout: 10000 });
		await expect.poll(() => main.evaluate((el) => el.scrollTop), { timeout: 10000 }).toBe(0);
		await expect(page.getByRole('heading', { name: DOC })).toBeInViewport();
	});
}

test('pill stays hidden when the page content does not overflow', async ({
	page,
	lightWorkspace,
}) => {
	const { projectSlug, token } = lightWorkspace;
	await page.setViewportSize({ width: 1280, height: 800 });
	await seedDoc(page, projectSlug, token, SHORT_CONTENT);

	await page.goto(`/projects/${projectSlug}/documents?file=${DOC}`);
	await waitForPageLoad(page);
	await expect(page.getByRole('heading', { name: DOC })).toBeVisible({ timeout: 20000 });

	// The document fits the viewport, so <main> has nothing to scroll and the
	// pill must not offer a jump.
	await expect(page.getByTestId('scroll-to-top')).toBeHidden();
});
