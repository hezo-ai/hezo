// Decision-tree item 1: dragging is asserted via boundingBox() against real
// fixed-position layout, and the portrait-mobile gate is a media query — both
// need real Chromium + setViewportSize. happy-dom covers the position math and
// tap/drag threshold in packages/web/test/{fab-position,use-draggable-fab}.
import { expect, test } from './fixtures';
import { createProjectAndClearPlanning, uniqueName, waitForPageLoad } from './helpers';

/** Drag a locator's center to (toX, toY) with enough steps to cross the 8px threshold. */
async function dragTo(
	page: import('@playwright/test').Page,
	locator: import('@playwright/test').Locator,
	toX: number,
	toY: number,
) {
	const box = await locator.boundingBox();
	if (!box) throw new Error('Missing layout box');
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(toX, toY, { steps: 12 });
	await page.mouse.up();
}

test.describe('Draggable floating buttons (portrait mobile)', () => {
	test('the chat launcher drags anywhere, clamps on-screen, and resets on reload', async ({
		page,
		sharedWorkspace,
	}) => {
		const { token } = sharedWorkspace;
		const project = await createProjectAndClearPlanning(page, '', token, {
			name: uniqueName('Drag Clamp'),
			description: 'E2E draggable chat launcher clamping.',
		});

		await page.setViewportSize({ width: 375, height: 800 });
		await page.goto(`/projects/${project.slug}/tasks`);
		await waitForPageLoad(page);

		const launcher = page.getByTestId('chat-launcher');
		await expect(launcher).toBeVisible({ timeout: 15000 });
		const home = await launcher.boundingBox();
		if (!home) throw new Error('Missing layout box');

		// Drag far past the top-left corner: the button must clamp fully inside
		// the viewport instead of leaving it.
		await dragTo(page, launcher, -100, -100);
		const dragged = await launcher.boundingBox();
		if (!dragged) throw new Error('Missing layout box');
		expect(dragged.x).toBeGreaterThanOrEqual(0);
		expect(dragged.y).toBeGreaterThanOrEqual(0);
		expect(dragged.x + dragged.width).toBeLessThanOrEqual(375);
		expect(dragged.y + dragged.height).toBeLessThanOrEqual(800);
		// …and it actually left the default bottom-right corner.
		expect(dragged.x).toBeLessThan(home.x - 50);
		expect(dragged.y).toBeLessThan(home.y - 50);

		// The drop must not count as a click — no chat panel.
		await expect(page.getByTestId('chat-panel')).toBeHidden();

		// Position is memory-only: a reload puts the button back in its corner.
		await page.reload();
		await waitForPageLoad(page);
		await expect(launcher).toBeVisible({ timeout: 15000 });
		const reloaded = await launcher.boundingBox();
		if (!reloaded) throw new Error('Missing layout box');
		expect(Math.abs(reloaded.x - home.x)).toBeLessThan(2);
		expect(Math.abs(reloaded.y - home.y)).toBeLessThan(2);
	});

	test('the chat launcher drags, keeps its spot across open/close, and snaps back on desktop', async ({
		page,
		sharedWorkspace,
	}) => {
		const { token } = sharedWorkspace;
		const project = await createProjectAndClearPlanning(page, '', token, {
			name: uniqueName('Drag Chat'),
			description: 'E2E draggable chat launcher.',
		});

		await page.setViewportSize({ width: 375, height: 800 });
		await page.goto(`/projects/${project.slug}/tasks`);
		await waitForPageLoad(page);

		const launcher = page.getByTestId('chat-launcher');
		await expect(launcher).toBeVisible({ timeout: 15000 });
		const home = await launcher.boundingBox();
		if (!home) throw new Error('Missing layout box');

		// Drag it to the mid-left of the screen.
		await dragTo(page, launcher, 40, 400);
		const dragged = await launcher.boundingBox();
		if (!dragged) throw new Error('Missing layout box');
		expect(dragged.x).toBeLessThan(home.x - 50);
		expect(Math.abs(dragged.y + dragged.height / 2 - 400)).toBeLessThan(30);

		// A tap still opens the chat panel in its normal mobile layout (the panel
		// is unaffected by the launcher's position — near-fullscreen sheet).
		await launcher.click();
		const panel = page.getByTestId('chat-panel');
		await expect(panel).toBeVisible();
		const panelBox = await panel.boundingBox();
		if (!panelBox) throw new Error('Missing layout box');
		expect(panelBox.width).toBeGreaterThan(300); // spans the viewport width
		await page.getByTestId('chat-close').click();

		// The launcher remounts where it was dragged (in-memory position).
		await expect(launcher).toBeVisible();
		const remounted = await launcher.boundingBox();
		if (!remounted) throw new Error('Missing layout box');
		expect(Math.abs(remounted.x - dragged.x)).toBeLessThan(2);
		expect(Math.abs(remounted.y - dragged.y)).toBeLessThan(2);

		// On desktop (gate off) the launcher is back at its fixed bottom-right
		// corner, and dragging does nothing.
		await page.setViewportSize({ width: 1280, height: 900 });
		const desktop = await launcher.boundingBox();
		if (!desktop) throw new Error('Missing layout box');
		expect(desktop.x).toBeGreaterThan(1280 / 2);
		expect(desktop.y).toBeGreaterThan(900 / 2);
		await dragTo(page, launcher, 200, 200);
		const afterDesktopDrag = await launcher.boundingBox();
		if (!afterDesktopDrag) throw new Error('Missing layout box');
		expect(Math.abs(afterDesktopDrag.x - desktop.x)).toBeLessThan(2);
		expect(Math.abs(afterDesktopDrag.y - desktop.y)).toBeLessThan(2);
	});
});
