// Real-CSS-layout assertion (testing decision tree, point 1): the in-page
// document preview panel is a `position: sticky` grid column pinned below the
// shell scroller. Whether its top stays pinned on scroll — and whether the panel
// fits within the scroller's visible area rather than overflowing below the fold —
// depends on the sticky box's height resolving against the real viewport and its
// grid cell, values happy-dom can't compute. So this lives in Playwright. The
// mention→panel flow itself is covered by
// packages/web/test/task-comment-doc-preview.test.tsx, and the resize/width
// behaviour by task-doc-preview-{resize,width}.spec.ts.

import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { createProjectAndClearPlanning, uniqueName, waitForPageLoad } from './helpers';

const DOC = 'guidelines.md';
// A doc long enough that the preview body overflows and the panel is driven to its
// max-height cap — the height whose (mis)sizing this spec guards.
const DOC_CONTENT = `# Guidelines\n\n${Array.from(
	{ length: 120 },
	(_, i) => `## Section ${i}\n\nParagraph body for section ${i}.`,
).join('\n\n')}`;

async function seedTaskWithLongThread(
	page: Page,
	token: string,
): Promise<{ projectSlug: string; taskId: string }> {
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

	const project = await createProjectAndClearPlanning(page, '', token, {
		name: uniqueName('Doc Preview Sticky'),
		description: 'Preview panel sticky-height test.',
	});

	const agentsRes = await page.request.get(`/api/projects/${project.slug}/agents`, { headers });
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const assigneeId = (agents.find((a) => a.slug === 'captain') ?? agents[0]).id;

	const docRes = await page.request.put(`/api/projects/${project.slug}/docs/${DOC}`, {
		headers,
		data: { content: DOC_CONTENT },
	});
	expect(docRes.ok()).toBe(true);

	const taskRes = await page.request.post(`/api/projects/${project.slug}/tasks`, {
		headers,
		data: { project_id: project.id, title: 'Review the guidelines', assignee_id: assigneeId },
	});
	const task = ((await taskRes.json()) as { data: { id: string; identifier: string } }).data;

	// The first comment carries the bare-filename mention that opens the in-page
	// preview panel. The rest pad the thread so the main content column overflows
	// the viewport, giving the shell <main> a real scroll range to test pinning.
	const bodies = [
		`Please review ${DOC} before we ship.`,
		...Array.from({ length: 24 }, (_, i) => `Follow-up note ${i} adding thread height to scroll.`),
	];
	for (const text of bodies) {
		const res = await page.request.post(`/api/projects/${project.slug}/tasks/${task.id}/comments`, {
			headers,
			data: { content_type: 'text', content: { text } },
		});
		expect(res.ok()).toBe(true);
	}

	return { projectSlug: project.slug, taskId: task.identifier.toLowerCase() };
}

/**
 * Seed just enough for the fit check: a doc long enough to drive the panel to
 * its max-height cap, and one comment carrying the mention that opens it. No
 * padded thread - this test asserts sizing, not scroll behaviour.
 */
async function seedTaskWithLongDoc(
	page: Page,
	token: string,
): Promise<{ projectSlug: string; taskId: string }> {
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
	const project = await createProjectAndClearPlanning(page, '', token, {
		name: uniqueName('Doc Preview Banner'),
		description: 'Preview panel height under shell chrome.',
	});
	const docRes = await page.request.put(`/api/projects/${project.slug}/docs/${DOC}`, {
		headers,
		data: { content: DOC_CONTENT },
	});
	expect(docRes.ok()).toBe(true);
	const agentsRes = await page.request.get(`/api/projects/${project.slug}/agents`, { headers });
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const assigneeId = (agents.find((a) => a.slug === 'captain') ?? agents[0]).id;

	const taskRes = await page.request.post(`/api/projects/${project.slug}/tasks`, {
		headers,
		data: { project_id: project.id, title: 'Review the guidelines', assignee_id: assigneeId },
	});
	expect(taskRes.ok()).toBe(true);
	const task = ((await taskRes.json()) as { data: { id: string; identifier: string } }).data;
	const commentRes = await page.request.post(
		`/api/projects/${project.slug}/tasks/${task.id}/comments`,
		{ headers, data: { content_type: 'text', content: { text: `Please review ${DOC}.` } } },
	);
	expect(commentRes.ok()).toBe(true);
	return { projectSlug: project.slug, taskId: task.identifier.toLowerCase() };
}

// Playwright-tier for the same reason as the spec below (real CSS layout), but
// guarding a different failure: the panel's cap is expressed against the shell
// scroller, so it has to survive the shell growing a row above <main>.
//
// It did not. The cap used to be `100vh - 4rem`, a literal for "viewport minus
// the app header minus my own top offset" - true only while the header is the
// only thing above <main>. When an update is available the shell renders a 47px
// banner between them, and the panel overhung the fold by exactly that, which is
// the "top rides up on scroll" symptom the cap exists to prevent. Every user with
// a newer release available was seeing it.
//
// The banner is driven by GET /api/updates/status, so stubbing that response is
// the whole setup - and the e2e server has the real check gated off
// (HEZO_SKIP_UPDATE_CHECK), so nothing else in the run can produce one.
test('the preview panel still fits the scroller when the shell renders a banner', async ({
	sharedPage: page,
	sharedWorkspace,
}) => {
	const { token } = sharedWorkspace;
	await page.setViewportSize({ width: 1280, height: 800 });

	const { projectSlug, taskId } = await seedTaskWithLongDoc(page, token);

	await page.route('**/api/updates/status', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				current: '0.0.1',
				latest: '9.9.9',
				updateAvailable: true,
				url: 'https://example.invalid/release',
				state: 'idle',
				canApply: false,
				autoUnlock: false,
			}),
		});
	});

	await page.goto(`/projects/${projectSlug}/tasks/${taskId}`);
	await waitForPageLoad(page);

	// The banner is the precondition, not the subject - if it never rendered the
	// fit assertion below would pass on the broken sizing too.
	const banner = page.getByTestId('update-banner');
	await expect(banner).toBeVisible({ timeout: 20000 });
	const bannerBox = await banner.boundingBox();
	expect(bannerBox?.height ?? 0).toBeGreaterThan(20);

	const mention = page.getByTestId('doc-mention-link').first();
	await expect(mention).toBeVisible({ timeout: 20000 });
	await mention.click();

	const panel = page.getByTestId('preview-panel');
	await expect(panel).toBeVisible();

	const scroller = page.locator('main').first();
	const box0 = await scroller.boundingBox();
	expect(box0).not.toBeNull();
	if (!box0) return;

	// The long doc drives the panel to its cap, so what follows measures the cap
	// rather than a short panel that would fit whatever the sizing said.
	const panel0 = await panel.boundingBox();
	expect(panel0).not.toBeNull();
	if (!panel0) return;
	expect(panel0.height).toBeGreaterThan(box0.height - 48);

	// Scroll so the panel is actually docked at its `top-4` offset. Unscrolled it
	// sits at its flow position - below the layout's own top padding, lower than
	// the offset it sticks to - so it legitimately extends past the fold there and
	// measuring it would test the padding, not the cap.
	const range = await scroller.evaluate((el) => el.scrollHeight - el.clientHeight);
	expect(range).toBeGreaterThan(40);
	const mid = Math.round(range * 0.5);
	await scroller.evaluate((el, top) => el.scrollTo({ top }), mid);
	await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(mid - 4);

	// The assertion. Docked, the panel sits entirely inside the scroller. On the
	// old `100vh - 4rem` cap - which subtracted the app header and nothing else -
	// its bottom landed the banner's full height (~47px) below the scroller's.
	const mainBox = await scroller.boundingBox();
	const pinned = await panel.boundingBox();
	expect(mainBox).not.toBeNull();
	expect(pinned).not.toBeNull();
	if (!mainBox || !pinned) return;
	expect(pinned.y).toBeGreaterThanOrEqual(mainBox.y - 1);
	expect(pinned.y + pinned.height).toBeLessThanOrEqual(mainBox.y + mainBox.height + 2);
});

test('the document preview panel fits the viewport and its top stays pinned on scroll', async ({
	sharedPage: page,
	sharedWorkspace,
}) => {
	const { token } = sharedWorkspace;
	const viewport = { width: 1280, height: 800 };
	await page.setViewportSize(viewport);

	const { projectSlug, taskId } = await seedTaskWithLongThread(page, token);
	await page.goto(`/projects/${projectSlug}/tasks/${taskId}`);
	await waitForPageLoad(page);

	// Open the doc in the in-grid preview panel (lg+ sticky column).
	const mention = page.getByTestId('doc-mention-link').first();
	await expect(mention).toBeVisible({ timeout: 20000 });
	await mention.click();

	const panel = page.getByTestId('preview-panel');
	await expect(panel).toBeVisible();
	const header = page.getByTestId('preview-panel-filename');
	await expect(header).toBeVisible();

	const scroller = page.locator('main').first();
	// Re-read at every comparison rather than captured once. The scroller's own
	// box is the frame of reference here, and it is not fixed: the app header
	// above it settles to a taller layout on a slow runner, so a `mainBox` taken
	// when the panel opened is stale by the time the post-scroll assertions use
	// it - and every offset measured against it is wrong by the difference.
	const mainBoxNow = async () => {
		const box = await scroller.boundingBox();
		expect(box).not.toBeNull();
		return box!;
	};
	const mainBox = await mainBoxNow();

	// The long doc drives the panel to its max-height cap — confirm the cap actually
	// engaged (the panel is nearly as tall as the scroller's visible area), otherwise
	// a trivially short panel would pass the fit check below without exercising the
	// sizing at all.
	const box0 = await panel.boundingBox();
	expect(box0).not.toBeNull();
	if (!box0) return;
	expect(box0.height).toBeGreaterThan(mainBox.height - 48);

	// The padded thread gives the scroller a real, meaningful range to scroll.
	const range = await scroller.evaluate((el) => el.scrollHeight - el.clientHeight);
	expect(range).toBeGreaterThan(300);

	// Scroll to a mid position (well past the layout's top padding so the sticky
	// panel is docked at its `top-4` offset, and well clear of the bottom where a
	// sticky box legitimately releases with its containing block).
	const midA = Math.round(range * 0.35);
	await scroller.evaluate((el, top) => el.scrollTo({ top }), midA);
	await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(midA - 4);

	// Pinned, the panel sits entirely within the scroller's visible area: its top
	// docked just below the app header and its bottom above the fold. The old
	// max-height (100vh − 2rem) ignored the h-12 (3rem) app header the scroller sits
	// below, so the pinned panel overran the scroller's bottom by ~2rem — this bound
	// fails on that sizing (bottom ≈ mainBottom + 32) and holds on the corrected one.
	const main1 = await mainBoxNow();
	const pinned = await panel.boundingBox();
	const headerTop1 = (await header.boundingBox())?.y ?? -1;
	expect(pinned).not.toBeNull();
	if (!pinned) return;
	expect(pinned.y).toBeGreaterThanOrEqual(main1.y - 1);
	expect(pinned.y + pinned.height).toBeLessThanOrEqual(main1.y + main1.height + 2);
	// Docked near the top of the scroller (below the header, at the sticky offset),
	// not risen out of view.
	expect(headerTop1).toBeGreaterThanOrEqual(main1.y - 1);
	expect(headerTop1).toBeLessThan(main1.y + 40);

	// Scroll further (still clear of the bottom): the panel top does not scroll out
	// of view — its header stays pinned at the same y. A panel taller than the
	// scrollport has too little stick room in its grid cell and its top rides up on
	// scroll — the symptom the height fix removes.
	const midB = Math.round(range * 0.65);
	await scroller.evaluate((el, top) => el.scrollTo({ top }), midB);
	await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(midB - 4);
	const headerTop2 = (await header.boundingBox())?.y ?? -1;
	const main2 = await mainBoxNow();
	expect(headerTop2).toBeGreaterThanOrEqual(main2.y - 1);
	expect(Math.abs(headerTop2 - headerTop1)).toBeLessThanOrEqual(2);
});
