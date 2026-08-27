// Viewport-conditional real-CSS-layout assertion (testing decision tree, points
// 1 & 2): the in-page document preview panel is grid column 2 whose track width
// is set by responsive `grid-cols-[1fr_Npx]` utilities that only diverge once a
// real layout pass evaluates the lg/xl/2xl media queries. happy-dom runs no media
// queries and returns zero-width boxes, so the widening can only be observed in a
// real browser at real viewport sizes. It also pins the panel's own travel to
// zero here, which is the same kind of media-query-only fact. The mention→panel
// data flow itself is covered by
// packages/web/test/task-comment-doc-preview.test.tsx; the motion by
// test/browser/panel-motion.mobile.spec.ts.

import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { createProjectAndClearPlanning, uniqueName, waitForPageLoad } from './helpers';

const DOC = 'spec.md';
const DOC_CONTENT = ['# Spec', '', 'The document body that renders in the preview panel.'].join(
	'\n',
);

async function seedTaskWithDocMention(
	page: Page,
	token: string,
): Promise<{ projectSlug: string; taskId: string }> {
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

	// Its own team+project (Blank template → Captain only), planning task cleared.
	const project = await createProjectAndClearPlanning(page, '', token, {
		name: uniqueName('Doc Preview Width'),
		description: 'Preview panel width test.',
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
		data: { project_id: project.id, title: 'Review the spec', assignee_id: assigneeId },
	});
	const task = ((await taskRes.json()) as { data: { id: string; identifier: string } }).data;

	// A bare filename in a comment resolves to a doc mention that opens the in-page
	// preview panel (not a new tab) on the task-detail surface.
	const commentRes = await page.request.post(
		`/api/projects/${project.slug}/tasks/${task.id}/comments`,
		{
			headers,
			data: { content_type: 'text', content: { text: `Please review ${DOC} before we ship.` } },
		},
	);
	expect(commentRes.ok()).toBe(true);

	return { projectSlug: project.slug, taskId: task.identifier.toLowerCase() };
}

test('document preview panel widens on xl/2xl screens (up to 2× its base width)', async ({
	sharedPage: page,
	sharedWorkspace,
}) => {
	const { token } = sharedWorkspace;
	await page.setViewportSize({ width: 1100, height: 900 });

	const { projectSlug, taskId } = await seedTaskWithDocMention(page, token);

	await page.goto(`/projects/${projectSlug}/tasks/${taskId}`);
	await waitForPageLoad(page);

	// Open the doc in the in-grid preview panel.
	const mention = page.getByTestId('doc-mention-link').first();
	await expect(mention).toBeVisible({ timeout: 20000 });

	// Catch the grid mid-open. The track transition is armed only across an open or
	// a close, so start watching before the click: by the time an awaited click
	// resolves the beat may already be spent. This pins the duration, not just its
	// presence — drop the `duration-[…]` utility and the track still animates, at
	// Tailwind's default speed, with every other assertion here still green.
	const armedDuration = page.evaluate(
		() =>
			new Promise<string>((resolve) => {
				const started = performance.now();
				const tick = () => {
					const grid = document.querySelector('[data-testid="preview-panel"]')?.closest('.grid');
					const duration = grid ? getComputedStyle(grid).transitionDuration : '0s';
					if (duration !== '0s') return resolve(duration);
					if (performance.now() - started > 4000) return resolve('never armed');
					requestAnimationFrame(tick);
				};
				tick();
			}),
	);
	await mention.click();
	expect(await armedDuration).toBe('0.3s');

	const panel = page.getByTestId('preview-panel');
	await expect(panel).toBeVisible();

	// At lg+ the widening track carries the panel's movement, so its own travel is
	// overridden to zero and it only fades. If that `lg:` variant stopped
	// compiling, the desktop panel would slide its full width in from off-screen —
	// a visible bug the width assertions below would sail straight past. Read it as
	// a number: this runs against the minified bundle in CI, and the exact text a
	// custom property ships as is the minifier's business, not this test's.
	expect(
		await panel.evaluate((el) =>
			Number.parseFloat(getComputedStyle(el).getPropertyValue('--panel-travel')),
		),
	).toBe(0);

	// The preview track is a fixed px width independent of the (scrollbar-sensitive)
	// 1fr content column, so the measured border-box lands on the track value ±a
	// couple px. Poll past the reflow after each resize, then read the settled box.
	const widthOnceAtLeast = async (floor: number): Promise<number> => {
		await expect
			.poll(async () => (await panel.boundingBox())?.width ?? 0, { timeout: 5000 })
			.toBeGreaterThanOrEqual(floor);
		return (await panel.boundingBox())?.width ?? 0;
	};

	// lg (1024–1279px): base track ≈ 360px.
	const lgWidth = await widthOnceAtLeast(352);
	expect(lgWidth).toBeLessThanOrEqual(368);

	// xl (1280–1535px): wider track ≈ 520px.
	await page.setViewportSize({ width: 1400, height: 900 });
	const xlWidth = await widthOnceAtLeast(512);
	expect(xlWidth).toBeLessThanOrEqual(528);
	expect(xlWidth).toBeGreaterThan(lgWidth);

	// 2xl (≥1536px): widest track ≈ 720px — twice the lg base.
	await page.setViewportSize({ width: 1600, height: 900 });
	const xxlWidth = await widthOnceAtLeast(712);
	expect(xxlWidth).toBeLessThanOrEqual(728);
	expect(xxlWidth).toBeGreaterThan(xlWidth);
	// Honors "can be twice as wide": the 2xl track is ≈2× the lg base.
	expect(xxlWidth).toBeGreaterThanOrEqual(lgWidth * 2 - 8);
});
