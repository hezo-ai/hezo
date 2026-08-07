// Real-CSS-layout assertions (testing decision tree, point 1): the copy button's
// overlay depends on the code block's typography margins collapsing *through* its
// relative wrapper, which is only observable via boundingBox() and
// getComputedStyle() after a real layout pass - happy-dom computes neither.

import { expect, test } from './fixtures';
import { waitForPageLoad } from './helpers';

// A fence between two paragraphs: lets us compare the gap above the block to the
// gap below it, which is what "the button doesn't push content down" means.
const CODE_MID = [
	'# Code doc',
	'',
	'Before the block.',
	'',
	'```sh',
	'echo one',
	'echo two',
	'```',
	'',
	'After the block.',
].join('\n');

// A body that is *only* a fence, so the block is both the first and the last
// child of the prose container - the case the wrapper's :first-child/:last-child
// margin compensation exists for.
const CODE_ONLY = ['```sh', 'echo hello', '```'].join('\n');

async function openDoc(
	page: import('@playwright/test').Page,
	projectSlug: string,
	token: string,
	filename: string,
	content: string,
) {
	const res = await page.request.put(`/api/projects/${projectSlug}/docs/${filename}`, {
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		data: { content },
	});
	expect(res.ok()).toBe(true);
	await page.goto(`/projects/${projectSlug}/documents?file=${filename}`);
	await waitForPageLoad(page);
	await expect(page.getByRole('heading', { name: filename })).toBeVisible({ timeout: 20000 });
}

test('the code-block copy button overlays the block without shifting layout', async ({
	page,
	lightWorkspace,
}) => {
	const { projectSlug, token } = lightWorkspace;
	await page.setViewportSize({ width: 1280, height: 800 });
	await openDoc(page, projectSlug, token, 'code-mid.md', CODE_MID);

	const wrapper = page.getByTestId('markdown-code-block').first();
	const pre = wrapper.locator('pre');
	await expect(pre).toBeVisible();

	// Collapse-through: with no padding/border/overflow on the wrapper, the pre's
	// typography margins collapse past it, so the two boxes coincide. Adding
	// `overflow-hidden` or padding to the wrapper fails right here.
	const wrapperBox = await wrapper.boundingBox();
	const preBox = await pre.boundingBox();
	expect(wrapperBox).not.toBeNull();
	expect(preBox).not.toBeNull();
	if (!wrapperBox || !preBox) return;
	expect(Math.abs(wrapperBox.x - preBox.x)).toBeLessThanOrEqual(1);
	expect(Math.abs(wrapperBox.y - preBox.y)).toBeLessThanOrEqual(1);
	expect(Math.abs(wrapperBox.width - preBox.width)).toBeLessThanOrEqual(1);
	expect(Math.abs(wrapperBox.height - preBox.height)).toBeLessThanOrEqual(1);

	// The button is hover-revealed on a pointer device, so hover before measuring.
	await wrapper.hover();
	const button = page.getByTestId('code-block-copy').first();
	await expect(button).toBeVisible();

	// Overlay: the button sits entirely inside the code block, so it occupies no
	// layout of its own.
	const btnBox = await button.boundingBox();
	expect(btnBox).not.toBeNull();
	if (!btnBox) return;
	expect(btnBox.x).toBeGreaterThanOrEqual(preBox.x);
	expect(btnBox.y).toBeGreaterThanOrEqual(preBox.y);
	expect(btnBox.x + btnBox.width).toBeLessThanOrEqual(preBox.x + preBox.width + 1);
	expect(btnBox.y + btnBox.height).toBeLessThanOrEqual(preBox.y + preBox.height + 1);

	// …in the bottom-right corner specifically: both edges are inset by the
	// `bottom-2 right-2` 8px (plus the pre's 1px border). Measured as a distance
	// to the corner rather than "past the midpoint", which a short block fails
	// for the wrong reason - a two-line fence is barely taller than the button.
	expect(preBox.x + preBox.width - (btnBox.x + btnBox.width)).toBeLessThanOrEqual(12);
	expect(preBox.y + preBox.height - (btnBox.y + btnBox.height)).toBeLessThanOrEqual(12);

	// No pushdown: the gap the block leaves above itself equals the gap below, and
	// the pre keeps its normal mid-document typography margins.
	const beforeBox = await page.getByText('Before the block.').boundingBox();
	const afterBox = await page.getByText('After the block.').boundingBox();
	expect(beforeBox).not.toBeNull();
	expect(afterBox).not.toBeNull();
	if (!beforeBox || !afterBox) return;
	const topGap = preBox.y - (beforeBox.y + beforeBox.height);
	const bottomGap = afterBox.y - (preBox.y + preBox.height);
	expect(Math.abs(topGap - bottomGap)).toBeLessThanOrEqual(1);
	expect(bottomGap).toBeGreaterThan(10);

	const margins = await pre.evaluate((el) => {
		const s = getComputedStyle(el);
		return { top: s.marginTop, bottom: s.marginBottom };
	});
	expect(margins.top).toBe(margins.bottom);
	expect(Number.parseFloat(margins.top)).toBeGreaterThan(10);

	// Mobile: same overlay guarantees at the narrow breakpoint.
	await page.setViewportSize({ width: 375, height: 800 });
	await expect(pre).toBeVisible();
	const mWrapperBox = await wrapper.boundingBox();
	const mPreBox = await pre.boundingBox();
	expect(mWrapperBox).not.toBeNull();
	expect(mPreBox).not.toBeNull();
	if (!mWrapperBox || !mPreBox) return;
	expect(Math.abs(mWrapperBox.height - mPreBox.height)).toBeLessThanOrEqual(1);

	await wrapper.hover();
	const mBtnBox = await button.boundingBox();
	expect(mBtnBox).not.toBeNull();
	if (!mBtnBox) return;
	expect(mBtnBox.x).toBeGreaterThanOrEqual(mPreBox.x);
	expect(mBtnBox.x + mBtnBox.width).toBeLessThanOrEqual(mPreBox.x + mPreBox.width + 1);
	expect(mBtnBox.y + mBtnBox.height).toBeLessThanOrEqual(mPreBox.y + mPreBox.height + 1);
});

test('a document that is only a code block keeps the first/last margin resets', async ({
	page,
	lightWorkspace,
}) => {
	const { projectSlug, token } = lightWorkspace;
	await page.setViewportSize({ width: 1280, height: 800 });
	await openDoc(page, projectSlug, token, 'code-only.md', CODE_ONLY);

	const pre = page.getByTestId('markdown-code-block').first().locator('pre');
	await expect(pre).toBeVisible();

	// Wrapping the pre moves `.prose > :first-child`/`:last-child` onto the
	// wrapper, whose margin is already 0 - and a collapse takes the max, so the
	// pre's own margin would survive without the compensating variants.
	// Computed style, not a bounding box: `.prose` has no padding, so an
	// uncompensated margin would collapse straight out through it and a y-delta
	// would read the same either way.
	const margins = await pre.evaluate((el) => {
		const s = getComputedStyle(el);
		return { top: s.marginTop, bottom: s.marginBottom };
	});
	expect(margins.top).toBe('0px');
	expect(margins.bottom).toBe('0px');
});
