import { expect, test } from './fixtures';
import { waitForPageLoad } from './helpers';

// Kept in Playwright by decision-tree items 1 & 2 (real CSS layout +
// viewport-conditional behavior): the CEO chat panel is a near-full-screen sheet
// on mobile and an anchored ~380px panel from md up. happy-dom doesn't run media
// queries against a real layout pass, so boundingBox must come from Chromium.
test.describe('CEO chat widget — responsive layout', () => {
	test('mobile is a near-full-screen sheet; desktop is an anchored panel', async ({
		sharedPage,
		sharedWorkspace,
	}) => {
		const page = sharedPage;

		await page.setViewportSize({ width: 375, height: 800 });
		await page.goto(`/projects/${sharedWorkspace.projectSlug}/tasks`);
		await waitForPageLoad(page);

		// The launcher mounts with the app shell; allow for cold-start boot latency.
		const launcher = page.getByTestId('ceo-chat-launcher');
		await expect(launcher).toBeVisible({ timeout: 15000 });
		await launcher.click();

		const panel = page.getByTestId('ceo-chat-panel');
		await expect(panel).toBeVisible();

		// Mobile: inset-x-2 (8px each side) on a 375px viewport → ~359px wide.
		const mobileBox = await panel.boundingBox();
		expect(mobileBox).not.toBeNull();
		expect(mobileBox?.width ?? 0).toBeGreaterThan(340);

		// Desktop: the same open panel re-lays out to the anchored ~420px width.
		await page.setViewportSize({ width: 1280, height: 800 });
		await expect(panel).toBeVisible();
		const desktopBox = await panel.boundingBox();
		expect(desktopBox).not.toBeNull();
		expect(desktopBox?.width ?? 0).toBeGreaterThan(340);
		expect(desktopBox?.width ?? 0).toBeLessThan(440);
	});

	test('expanding fills the viewport but never covers the nav bar', async ({
		sharedPage,
		sharedWorkspace,
	}) => {
		const page = sharedPage;

		await page.setViewportSize({ width: 1280, height: 800 });
		await page.goto(`/projects/${sharedWorkspace.projectSlug}/tasks`);
		await waitForPageLoad(page);

		const launcher = page.getByTestId('ceo-chat-launcher');
		await expect(launcher).toBeVisible({ timeout: 15000 });
		await launcher.click();

		const panel = page.getByTestId('ceo-chat-panel');
		await expect(panel).toBeVisible();

		// Anchored by default: a narrow corner panel.
		const anchored = await panel.boundingBox();
		expect(anchored?.width ?? 0).toBeLessThan(440);

		// Expand → fills the viewport width…
		await page.getByTestId('ceo-chat-expand').click();
		await expect(panel).toHaveAttribute('data-expanded', 'true');
		const expandedBox = await panel.boundingBox();
		expect(expandedBox).not.toBeNull();
		expect(expandedBox?.width ?? 0).toBeGreaterThan(1000);

		// …but its top stays at or below the header's bottom — the nav stays visible.
		const header = await page.getByTestId('app-header').boundingBox();
		const headerBottom = (header?.y ?? 0) + (header?.height ?? 0);
		expect(headerBottom).toBeGreaterThan(0);
		expect(expandedBox?.y ?? 0).toBeGreaterThanOrEqual(headerBottom - 1);

		// A modal scrim now occludes the page content below the nav: full viewport
		// width, starting at the header's bottom (the nav itself stays uncovered).
		const overlay = page.getByTestId('ceo-chat-overlay');
		await expect(overlay).toBeVisible();
		const overlayBox = await overlay.boundingBox();
		expect(overlayBox?.width ?? 0).toBeGreaterThan(1200);
		expect(overlayBox?.y ?? 0).toBeGreaterThanOrEqual(headerBottom - 1);

		// Collapse restores the anchored corner panel and removes the scrim.
		await page.getByTestId('ceo-chat-expand').click();
		await expect(panel).toHaveAttribute('data-expanded', 'false');
		await expect(overlay).toBeHidden();
		const restored = await panel.boundingBox();
		expect(restored?.width ?? 0).toBeLessThan(440);
	});

	test('Escape closes the chat', async ({ sharedPage, sharedWorkspace }) => {
		const page = sharedPage;

		await page.setViewportSize({ width: 1280, height: 800 });
		await page.goto(`/projects/${sharedWorkspace.projectSlug}/tasks`);
		await waitForPageLoad(page);

		const launcher = page.getByTestId('ceo-chat-launcher');
		await expect(launcher).toBeVisible({ timeout: 15000 });
		await launcher.click();
		await expect(page.getByTestId('ceo-chat-panel')).toBeVisible();

		await page.keyboard.press('Escape');
		await expect(page.getByTestId('ceo-chat-panel')).toBeHidden();
		await expect(launcher).toBeVisible();
	});

	test('the expand toggle is desktop-only — hidden on mobile', async ({
		sharedPage,
		sharedWorkspace,
	}) => {
		const page = sharedPage;

		await page.setViewportSize({ width: 375, height: 800 });
		await page.goto(`/projects/${sharedWorkspace.projectSlug}/tasks`);
		await waitForPageLoad(page);

		const launcher = page.getByTestId('ceo-chat-launcher');
		await expect(launcher).toBeVisible({ timeout: 15000 });
		await launcher.click();
		await expect(page.getByTestId('ceo-chat-panel')).toBeVisible();

		// The mobile panel is already near-full-screen, so the control is hidden.
		await expect(page.getByTestId('ceo-chat-expand')).toBeHidden();
	});

	// Kept in Playwright by decision-tree item 1 (real CSS layout): this is a
	// scroll-position regression, and scrollTop/scrollHeight/clientHeight only
	// carry real values under Chromium's layout engine — happy-dom returns 0.
	test('collapsing the panel keeps the latest message pinned to the bottom', async ({
		sharedPage,
		sharedWorkspace,
	}) => {
		const page = sharedPage;
		await page.setViewportSize({ width: 1280, height: 760 });

		const LAST_MARKER = 'LASTCEOREPLYMARKER';
		const seeded = Array.from({ length: 24 }, (_, i) => {
			const isUser = i % 2 === 0;
			const isLast = i === 23;
			return {
				id: `seed-${i}`,
				conversation_id: 'conv-seed',
				role: isUser ? 'user' : 'assistant',
				channel: 'web',
				status: 'complete',
				content: isLast
					? `${LAST_MARKER}. The CEO's final reply that must remain visible.`
					: `${isUser ? 'You' : 'CEO'} message ${i}. ${'Filler sentence to grow the bubble height. '.repeat(4)}`,
				created_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
			};
		});

		// The widget swaps the scrollable message list for an HQ-container notice
		// unless HQ is healthy. Force the instance (is_internal) project to
		// "running" so the list renders regardless of the env's container state.
		await page.route('**/api/projects', async (route) => {
			if (route.request().method() !== 'GET') return route.fallback();
			const response = await route.fetch();
			const body = (await response.json()) as { data?: Array<Record<string, unknown>> };
			const data = Array.isArray(body.data)
				? body.data.map((p) => (p.is_internal ? { ...p, container_status: 'running' } : p))
				: body.data;
			await route.fulfill({ response, json: { ...body, data } });
		});

		// A real CEO reply needs the HQ container + a live LLM, so mock the read
		// endpoint to get a deterministic conversation that overflows the panel.
		await page.route('**/api/ceo/conversation', (route) =>
			route.fulfill({ json: { data: { conversation_id: 'conv-seed', messages: seeded } } }),
		);

		await page.goto(`/projects/${sharedWorkspace.projectSlug}/tasks`);
		await waitForPageLoad(page);

		const launcher = page.getByTestId('ceo-chat-launcher');
		await expect(launcher).toBeVisible({ timeout: 15000 });
		await launcher.click();

		const panel = page.getByTestId('ceo-chat-panel');
		await expect(panel).toBeVisible();
		await expect(panel).toHaveAttribute('data-expanded', 'false');

		const list = page.getByTestId('ceo-chat-messages');
		const distanceFromBottom = () =>
			list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);

		// Sanity: the seeded conversation actually overflows the anchored panel —
		// otherwise there's nothing to scroll and the assertion below is vacuous.
		await expect
			.poll(async () => list.evaluate((el) => el.scrollHeight - el.clientHeight))
			.toBeGreaterThan(100);

		// Opening pins to the bottom — the newest reply is visible.
		await expect.poll(distanceFromBottom).toBeLessThanOrEqual(8);

		// Put the list in a not-at-bottom state before toggling. This is what an
		// in-flight (streaming) reply leaves behind between tokens — and it's also
		// what defeats Chromium's scroll anchoring, which on its own restores a
		// *symmetric* expand→collapse to the bottom and so would mask the bug.
		await list.evaluate((el) => el.scrollTo({ top: 0, behavior: 'instant' }));
		await expect.poll(distanceFromBottom).toBeGreaterThan(100);

		// Expand to the full-viewport sheet, then collapse back to the corner panel.
		await page.getByTestId('ceo-chat-expand').click();
		await expect(panel).toHaveAttribute('data-expanded', 'true');
		await page.getByTestId('ceo-chat-expand').click();
		await expect(panel).toHaveAttribute('data-expanded', 'false');

		// Regression guard: each resize must re-pin the list to the bottom so the
		// newest reply stays visible. Without the fix the resize doesn't scroll and
		// the list is left where it was (top), hiding the latest message.
		await expect.poll(distanceFromBottom, { timeout: 5000 }).toBeLessThanOrEqual(8);
		await expect(page.getByText(LAST_MARKER)).toBeInViewport();
	});
});

// Kept in Playwright by decision-tree item 1 (real CSS layout): the composer
// auto-grows by measuring its own `scrollHeight` and writing back an inline
// height. happy-dom reports `scrollHeight` as 0, so the grow/collapse can only
// be observed against Chromium's real layout pass.
test.describe('CEO chat widget — composer auto-grow', () => {
	test('the composer grows with multi-line input and collapses after submit', async ({
		sharedPage,
		sharedWorkspace,
	}) => {
		const page = sharedPage;

		await page.setViewportSize({ width: 1280, height: 800 });
		await page.goto(`/projects/${sharedWorkspace.projectSlug}/tasks`);
		await waitForPageLoad(page);

		const launcher = page.getByTestId('ceo-chat-launcher');
		await expect(launcher).toBeVisible({ timeout: 15000 });
		await launcher.click();
		await expect(page.getByTestId('ceo-chat-panel')).toBeVisible();

		const input = page.getByTestId('ceo-chat-input');
		const heightOf = async () => (await input.boundingBox())?.height ?? 0;

		// Empty composer starts as a single row.
		const initialHeight = await heightOf();
		expect(initialHeight).toBeGreaterThan(0);

		// Several lines of input expand the box well past its single-row height.
		await input.fill(['one', 'two', 'three', 'four', 'five'].join('\n'));
		await expect.poll(heightOf).toBeGreaterThan(initialHeight + 20);

		// Submitting clears the draft, collapsing the composer back to one row.
		await page.getByTestId('ceo-chat-send').click();
		await expect(input).toHaveValue('');
		await expect.poll(heightOf).toBeLessThan(initialHeight + 8);
	});
});
