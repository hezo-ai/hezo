// Real-CSS-layout + native-pointer-drag assertion (testing decision tree, points
// 1 & 3): the in-page document preview panel is grid column 2 whose width can be
// changed by dragging the divider between it and the task content. happy-dom has
// no layout and can't dispatch a real pointer drag, so the divider's pixel
// behavior — widen/narrow, clamping, persistence — can only be observed in a real
// browser. The reusable ResizableSplit wiring itself is unit-covered by
// packages/web/test/resizable-split.test.tsx; the mention→panel flow by
// packages/web/test/task-comment-doc-preview.test.tsx.

import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { createProjectAndClearPlanning, uniqueName, waitForPageLoad } from './helpers';

const DOC = 'spec.md';
const DOC_CONTENT = ['# Spec', '', 'The document body that renders in the preview panel.'].join(
	'\n',
);
const MIN_PANEL_WIDTH = 280;
const MIN_MAIN_WIDTH = 380;
const STEP = 24;

async function seedTaskWithDocMention(
	page: Page,
	token: string,
): Promise<{ projectSlug: string; taskId: string }> {
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

	const project = await createProjectAndClearPlanning(page, '', token, {
		name: uniqueName('Doc Preview Resize'),
		description: 'Preview panel resize test.',
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

async function openPreview(page: Page): Promise<Locator> {
	const mention = page.getByTestId('doc-mention-link').first();
	await expect(mention).toBeVisible({ timeout: 20000 });
	await mention.click();
	const panel = page.getByTestId('preview-panel');
	await expect(panel).toBeVisible();
	return panel;
}

const panelWidth = async (panel: Locator): Promise<number> =>
	(await panel.boundingBox())?.width ?? 0;

/** Settle after a resize, then read the panel's border-box width. */
async function widthAfterReflow(
	panel: Locator,
	predicate: (w: number) => boolean,
): Promise<number> {
	await expect.poll(async () => predicate(await panelWidth(panel)), { timeout: 5000 }).toBe(true);
	return panelWidth(panel);
}

/** Press on the divider's center, returning that grab point (page coords). */
async function grabDivider(page: Page): Promise<{ x: number; y: number }> {
	const box = await page.getByTestId('resize-handle').boundingBox();
	if (!box) throw new Error('resize-handle has no bounding box');
	const x = box.x + box.width / 2;
	const y = box.y + Math.min(box.height / 2, 80); // stay within the viewport
	await page.mouse.move(x, y);
	await page.mouse.down();
	return { x, y };
}

/** Drag the divider by `dx` px (negative = left → widens the right-hand panel). */
async function dragBy(page: Page, dx: number): Promise<void> {
	const { x, y } = await grabDivider(page);
	await page.mouse.move(x + dx, y, { steps: 12 });
	await page.mouse.up();
}

/** Drag the divider to an absolute page X (used to over-drag against the clamps). */
async function dragToX(page: Page, targetX: number): Promise<void> {
	const { y } = await grabDivider(page);
	await page.mouse.move(targetX, y, { steps: 12 });
	await page.mouse.up();
}

test('the divider drags to resize the preview panel, clamps, and persists', async ({
	sharedPage: page,
	sharedWorkspace,
}) => {
	const { token } = sharedWorkspace;
	const viewport = { width: 1440, height: 900 };
	await page.setViewportSize(viewport);

	const { projectSlug, taskId } = await seedTaskWithDocMention(page, token);
	await page.goto(`/projects/${projectSlug}/tasks/${taskId}`);
	await waitForPageLoad(page);

	const panel = await openPreview(page);
	const w0 = await panelWidth(panel);
	expect(w0).toBeGreaterThan(MIN_PANEL_WIDTH);

	// The grid container width bounds how wide the panel can get (main column keeps
	// MIN_MAIN_WIDTH). Read it off the panel's grid ancestor.
	const containerWidth = await panel.evaluate(
		(el) => el.closest('.grid')?.getBoundingClientRect().width ?? 0,
	);
	expect(containerWidth).toBeGreaterThan(0);

	// Drag left → the right-hand panel widens by ~120px.
	await dragBy(page, -120);
	const widened = await widthAfterReflow(panel, (w) => w > w0 + 100);
	expect(widened).toBeLessThanOrEqual(w0 + 140);

	// Drag right → it narrows back down below the original width.
	await dragBy(page, 220);
	const narrowed = await widthAfterReflow(panel, (w) => w < widened - 180);
	expect(narrowed).toBeLessThan(w0);

	// Over-drag to the right viewport edge → clamps at MIN_PANEL_WIDTH.
	await dragToX(page, viewport.width - 4);
	const min = await widthAfterReflow(panel, (w) => w <= MIN_PANEL_WIDTH + 6);
	expect(min).toBeGreaterThanOrEqual(MIN_PANEL_WIDTH - 6);

	// Over-drag to the left viewport edge → clamps so the main column keeps MIN_MAIN_WIDTH.
	await dragToX(page, 4);
	const expectedMax = containerWidth - MIN_MAIN_WIDTH;
	const max = await widthAfterReflow(panel, (w) => w >= expectedMax - 8);
	expect(max).toBeLessThanOrEqual(expectedMax + 8);

	// Keyboard: back down to MIN for headroom, then step up by STEP with ArrowLeft.
	await dragToX(page, viewport.width - 4);
	const beforeKey = await widthAfterReflow(panel, (w) => w <= MIN_PANEL_WIDTH + 6);
	await page.getByTestId('resize-handle').focus();
	await page.keyboard.press('ArrowLeft'); // right side: ← widens
	const afterKey = await widthAfterReflow(panel, (w) => w > beforeKey + 6);
	expect(Math.abs(afterKey - (beforeKey + STEP))).toBeLessThanOrEqual(6);

	// Persistence: settle on a distinct width, reload, reopen — it restores.
	await dragBy(page, -160);
	const settled = await widthAfterReflow(panel, (w) => w > afterKey + 100);
	await page.reload();
	await waitForPageLoad(page);
	const reopened = await openPreview(page);
	const restored = await widthAfterReflow(reopened, (w) => Math.abs(w - settled) <= 8);
	expect(Math.abs(restored - settled)).toBeLessThanOrEqual(8);
});
