// Playwright for two reasons off the decision tree. #1 real CSS layout: the org
// chart is shrunk by a `transform: scale()` into a sizer box, and "no card is
// clipped" means comparing live client rects against a scroll container's client
// box across a scroll - happy-dom answers 0 to every one of those reads. #2
// viewport-conditional: the whole point of the change is that the same roster
// fits, floors and scrolls differently at phone, tablet and desktop widths.
//
// The regression it guards: the chart used to measure itself with `scrollWidth`
// on a container-width content box centred by `items-center`. A row wider than
// the column overflows symmetrically, and in LTR `scrollWidth` only ever reports
// the right half - so the chart was measured about half its overhang too narrow,
// scaled too little, and sheared on both sides.

import type { Locator, Page } from '@playwright/test';
import { ORG_CHART_MIN_SCALE } from '../../packages/web/src/lib/org-chart-fit';
import { expect, test } from './fixtures';
import { waitForPageLoad } from './helpers';

const CHART = 'team-org-chart';

/** Layout numbers the assertions need, read in one round trip. */
async function readViewport(viewport: Locator) {
	return viewport.evaluate((el) => ({
		left: el.getBoundingClientRect().left,
		clientWidth: el.clientWidth,
		scrollWidth: el.scrollWidth,
		scrollLeft: el.scrollLeft,
	}));
}

/** The applied scale, straight off the computed transform matrix. */
async function readScale(page: Page): Promise<number> {
	return page.getByTestId(`${CHART}-canvas`).evaluate((el) => {
		const content = el.firstElementChild;
		if (!(content instanceof HTMLElement)) return 1;
		const transform = getComputedStyle(content).transform;
		if (!transform || transform === 'none') return 1;
		return new DOMMatrixReadOnly(transform).a;
	});
}

/** Outermost painted edges of every agent card. */
async function cardEdges(cards: Locator) {
	return cards.evaluateAll((els) => {
		const rects = els.map((el) => el.getBoundingClientRect());
		return {
			minLeft: Math.min(...rects.map((r) => r.left)),
			maxRight: Math.max(...rects.map((r) => r.right)),
		};
	});
}

async function scrollChartTo(viewport: Locator, position: 'start' | 'end') {
	await viewport.evaluate((el, pos) => {
		el.scrollLeft = pos === 'start' ? 0 : el.scrollWidth;
	}, position);
}

async function openChart(page: Page, projectSlug: string) {
	await page.goto(`/projects/${projectSlug}/agents`);
	await waitForPageLoad(page);
	const viewport = page.getByTestId(`${CHART}-viewport`);
	await expect(viewport).toBeVisible({ timeout: 15_000 });
	const cards = viewport.getByRole('link');
	await expect(cards.first()).toBeVisible({ timeout: 15_000 });
	return { viewport, cards };
}

const BREAKPOINTS = [
	{ name: 'mobile', width: 390, height: 844 },
	{ name: 'tablet', width: 820, height: 1024 },
	{ name: 'desktop', width: 1440, height: 900 },
] as const;

for (const bp of BREAKPOINTS) {
	test(`the whole org chart is reachable at ${bp.name} (${bp.width}px)`, async ({
		sharedPage: page,
		sharedWorkspace,
	}) => {
		await page.setViewportSize({ width: bp.width, height: bp.height });
		const { viewport, cards } = await openChart(page, sharedWorkspace.projectSlug);

		// The floor is the readability guarantee: past it the chart scrolls rather
		// than shrinking into illegibility.
		expect(await readScale(page)).toBeGreaterThanOrEqual(ORG_CHART_MIN_SCALE - 1e-6);

		// The chart must never widen the page itself, at any width.
		const pageOverflow = await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
		);
		expect(pageOverflow).toBeLessThanOrEqual(1);

		// Scrolled fully left, nothing sits off the left edge. This is the direct
		// regression: under the old measurement the leftmost card was hundreds of
		// pixels out, and unreachable, because the overflow was symmetric.
		await scrollChartTo(viewport, 'start');
		const atStart = await readViewport(viewport);
		expect(atStart.scrollLeft).toBe(0);
		expect((await cardEdges(cards)).minLeft).toBeGreaterThanOrEqual(atStart.left - 1);

		// Scrolled fully right, nothing sits off the right edge either - so the
		// scroll extent really does span the whole chart.
		await scrollChartTo(viewport, 'end');
		const atEnd = await readViewport(viewport);
		expect((await cardEdges(cards)).maxRight).toBeLessThanOrEqual(
			atEnd.left + atEnd.clientWidth + 1,
		);

		// No dead scroll space. Drop the sizer and the scroll extent reverts to the
		// chart's *unscaled* width, leaving hundreds of pixels of nothing to pan
		// through - a transform paints smaller but leaves the layout box alone.
		const canvasWidth = await page
			.getByTestId(`${CHART}-canvas`)
			.evaluate((el) => el.getBoundingClientRect().width);
		expect(atEnd.scrollWidth).toBeLessThanOrEqual(Math.max(atEnd.clientWidth, canvasWidth) + 2);
	});
}

test('a chart that fits is centred and does not scroll', async ({ page, lightWorkspace }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const { viewport } = await openChart(page, lightWorkspace.projectSlug);

	expect(await readScale(page)).toBe(1);

	const { left, clientWidth, scrollWidth } = await readViewport(viewport);
	expect(scrollWidth).toBeLessThanOrEqual(clientWidth);

	// `mx-auto` still centres the common case. Fixing the overflow regime by
	// left-aligning everything would pass every assertion above and look wrong on
	// every desktop, so it is asserted separately.
	const canvas = await page
		.getByTestId(`${CHART}-canvas`)
		.evaluate((el) => el.getBoundingClientRect());
	const leftGap = canvas.left - left;
	const rightGap = left + clientWidth - canvas.right;
	expect(Math.abs(leftGap - rightGap)).toBeLessThanOrEqual(2);
});
