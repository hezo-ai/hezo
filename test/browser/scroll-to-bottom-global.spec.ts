// Real clientHeight/scrollHeight/scrollTop comparisons (testing decision tree,
// point 1): the global scroll-to-bottom pill only surfaces while the shell
// <main> (or the bare preview page's own scroller) is genuinely being scrolled
// down, and clicking it must move the real scroll position — values happy-dom
// can't compute. The task-page variant of this behaviour is covered in
// task-detail.spec.ts; this spec proves the pill is global by exercising it on a
// documents page and on the standalone document preview.

import { expect, test } from './fixtures';
import { waitForPageLoad } from './helpers';

const DOC = 'long-doc.md';

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
	test(`${name}: pill surfaces on downward scroll and scrolls to the bottom`, async ({
		page,
		lightWorkspace,
	}) => {
		const { projectSlug, token } = lightWorkspace;
		await page.setViewportSize({ width, height });
		await seedDoc(page, projectSlug, token, LONG_CONTENT);

		await page.goto(`/projects/${projectSlug}/documents?file=${DOC}`);
		await waitForPageLoad(page);
		await expect(page.getByRole('heading', { name: DOC })).toBeVisible({ timeout: 20000 });

		const button = page.getByTestId('scroll-to-bottom');
		const main = page.locator('main').first();

		// Landing at the top without scrolling: the pill offers nothing yet.
		await expect(button).toBeHidden();

		// A downward scroll (short of the bottom) reveals it.
		await main.evaluate((el) => el.scrollBy({ top: 400 }));
		await expect(button).toBeVisible();

		await button.click();

		// The pill hides once the scroller reaches the bottom, and the real scroll
		// position confirms the content genuinely moved.
		await expect(button).toBeHidden({ timeout: 10000 });
		await expect
			.poll(() => main.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight), {
				timeout: 10000,
			})
			.toBeLessThan(200);
		await expect(page.getByText('THE-VERY-END')).toBeInViewport();
	});
}

test('pill fades out a couple seconds after downward scrolling stops', async ({
	page,
	lightWorkspace,
}) => {
	const { projectSlug, token } = lightWorkspace;
	await page.setViewportSize({ width: 1280, height: 800 });
	await seedDoc(page, projectSlug, token, LONG_CONTENT);

	await page.goto(`/projects/${projectSlug}/documents?file=${DOC}`);
	await waitForPageLoad(page);
	await expect(page.getByRole('heading', { name: DOC })).toBeVisible({ timeout: 20000 });

	const button = page.getByTestId('scroll-to-bottom');
	const main = page.locator('main').first();

	await main.evaluate((el) => el.scrollBy({ top: 400 }));
	await expect(button).toBeVisible();

	// No further scrolling: the idle timer elapses and the pill hides on its own,
	// without ever reaching the bottom.
	await expect(button).toBeHidden({ timeout: 6000 });
	const remaining = await main.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
	expect(remaining).toBeGreaterThan(200);
});

test('scrolling back up hides the scroll-to-bottom pill immediately', async ({
	page,
	lightWorkspace,
}) => {
	const { projectSlug, token } = lightWorkspace;
	await page.setViewportSize({ width: 1280, height: 800 });
	await seedDoc(page, projectSlug, token, LONG_CONTENT);

	await page.goto(`/projects/${projectSlug}/documents?file=${DOC}`);
	await waitForPageLoad(page);
	await expect(page.getByRole('heading', { name: DOC })).toBeVisible({ timeout: 20000 });

	const button = page.getByTestId('scroll-to-bottom');
	const main = page.locator('main').first();

	await main.evaluate((el) => el.scrollBy({ top: 600 }));
	await expect(button).toBeVisible();

	// Reversing direction is the opposite intent — the down pill goes away at once.
	await main.evaluate((el) => el.scrollBy({ top: -200 }));
	await expect(button).toBeHidden();
});

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

	// The document fits the viewport, so <main> has nothing to scroll — an
	// attempted downward scroll produces no scroll event and the pill never shows.
	const main = page.locator('main').first();
	const overflow = await main.evaluate((el) => el.scrollHeight - el.clientHeight);
	expect(overflow).toBeLessThanOrEqual(200);
	await main.evaluate((el) => el.scrollBy({ top: 400 }));
	await expect(page.getByTestId('scroll-to-bottom')).toBeHidden();
});

test('pill works on the standalone (bare) document preview page', async ({
	page,
	lightWorkspace,
}) => {
	const { projectSlug, token } = lightWorkspace;
	await page.setViewportSize({ width: 1280, height: 800 });
	await seedDoc(page, projectSlug, token, LONG_CONTENT);

	await page.goto(`/preview/${projectSlug}/${DOC}`);
	// No waitForPageLoad here: the bare route renders without the shell's <main>,
	// which that helper gates on. The toolbar is the page's own mounted signal.
	await expect(page.getByTestId('preview-review-toolbar')).toBeVisible({ timeout: 20000 });

	const button = page.getByTestId('scroll-to-bottom');
	const scroller = page.getByTestId('preview-scroller');

	await expect(button).toBeHidden();
	await scroller.evaluate((el) => el.scrollBy({ top: 400 }));
	await expect(button).toBeVisible();
	await button.click();

	await expect(button).toBeHidden({ timeout: 10000 });
	await expect(page.getByText('THE-VERY-END')).toBeInViewport();
});
