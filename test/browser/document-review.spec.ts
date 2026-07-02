// Real-layout + native-selection assertions (testing decision tree, points
// 1-3): the selection pill is positioned from live Range rects, margin-icon
// alignment is a boundingBox comparison, the hover-raised ghost and the mobile
// bottom-sheet editor depend on a real layout pass — happy-dom returns zero
// rects for all of them. The data flows themselves are covered by
// packages/web/test/document-review.test.tsx.

import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const DOC = 'review-flow.md';
const CONTENT = [
	'# Review flow',
	'',
	'First paragraph mentions **Selectme** once for the selection test.',
	'',
	'Second paragraph is the hover target line for whole-line comments.',
].join('\n');

async function seedDoc(page: Page, projectSlug: string, token: string): Promise<void> {
	const res = await page.request.put(`/api/projects/${projectSlug}/docs/${DOC}`, {
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		data: { content: CONTENT },
	});
	expect(res.ok()).toBe(true);
}

test('desktop: select text → comment → highlight with aligned margin icon; hover-line ghost comments the whole line', async ({
	page,
	lightWorkspace,
}) => {
	const { projectSlug, token } = lightWorkspace;
	await page.setViewportSize({ width: 1280, height: 800 });
	await seedDoc(page, projectSlug, token);

	await page.goto(`/preview/${projectSlug}/${DOC}`);
	await expect(page.getByText('First paragraph mentions')).toBeVisible({ timeout: 20000 });

	// Native double-click word selection raises the floating comment pill.
	await page.locator('strong', { hasText: 'Selectme' }).dblclick();
	const pill = page.getByTestId('review-selection-pill');
	await expect(pill).toBeVisible();
	await pill.click();

	const editor = page.getByTestId('review-editor');
	await expect(editor).toBeVisible();
	await expect(editor).toContainText('Selectme');
	await page.getByTestId('review-editor-textarea').fill('Rename this token');
	await page.getByTestId('review-editor-save').click();

	const mark = page.locator('mark[data-review-id]');
	await expect(mark).toHaveText('Selectme', { timeout: 15000 });

	// Google-Docs-style margin icon sits level with its highlight.
	const icon = page.getByTestId('review-margin-icon');
	await expect(icon).toBeVisible();
	const markBox = await mark.boundingBox();
	const iconBox = await icon.boundingBox();
	expect(markBox).not.toBeNull();
	expect(iconBox).not.toBeNull();
	if (markBox && iconBox) {
		expect(Math.abs(iconBox.y - markBox.y)).toBeLessThanOrEqual(24);
	}

	// The floating toolbar reflects the review state.
	await expect(page.getByTestId('review-count-chip')).toContainText('1');

	// Hovering a line raises the dashed ghost icon; clicking it comments on the
	// entire line.
	await page.getByText('Second paragraph is the hover target').hover();
	const ghost = page.getByTestId('review-line-ghost');
	await expect(ghost).toBeVisible();
	await ghost.click();
	await expect(page.getByTestId('review-editor')).toContainText(
		'Second paragraph is the hover target line',
	);
	await page.getByTestId('review-editor-textarea').fill('Tighten this line');
	await page.getByTestId('review-editor-save').click();

	await expect(page.locator('mark[data-review-id]')).toHaveCount(2, { timeout: 15000 });
	await expect(page.locator('mark[data-review-id]').nth(1)).toHaveText(
		'Second paragraph is the hover target line for whole-line comments.',
	);
	await expect(page.getByTestId('review-margin-icon')).toHaveCount(2);
});

test('mobile 375px: layout fits and tapping a highlight opens the bottom-sheet editor', async ({
	page,
	lightWorkspace,
}) => {
	const { projectSlug, token } = lightWorkspace;
	await page.setViewportSize({ width: 375, height: 800 });
	await seedDoc(page, projectSlug, token);
	const created = await page.request.post(
		`/api/projects/${projectSlug}/docs/${DOC}/review-comments`,
		{
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
			data: { quote: 'Selectme', occurrence: 0, comment: 'Rename this token' },
		},
	);
	expect(created.ok()).toBe(true);

	await page.goto(`/preview/${projectSlug}/${DOC}`);
	const mark = page.locator('mark[data-review-id]');
	await expect(mark).toBeVisible({ timeout: 20000 });

	// Mobile-first: nothing overflows the 375px viewport horizontally.
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - window.innerWidth,
	);
	expect(overflow).toBeLessThanOrEqual(1);

	// The margin icon is still present in the slim gutter.
	await expect(page.getByTestId('review-margin-icon')).toBeVisible();

	// Tapping the highlight opens the editor as a bottom sheet pinned to the
	// viewport bottom (below the sm breakpoint).
	await mark.click();
	const editor = page.getByTestId('review-editor');
	await expect(editor).toBeVisible();
	const box = await editor.boundingBox();
	expect(box).not.toBeNull();
	if (box) {
		expect(box.y + box.height).toBeGreaterThanOrEqual(790);
		expect(box.width).toBeGreaterThanOrEqual(370);
	}
});
