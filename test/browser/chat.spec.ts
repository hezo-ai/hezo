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
		const launcher = page.getByTestId('chat-launcher');
		await expect(launcher).toBeVisible({ timeout: 15000 });
		await launcher.click();

		const panel = page.getByTestId('chat-panel');
		await expect(panel).toBeVisible();

		// Mobile: inset-x-2 (8px each side) on a 375px viewport → ~359px wide.
		const mobileBox = await panel.boundingBox();
		expect(mobileBox).not.toBeNull();
		expect(mobileBox?.width ?? 0).toBeGreaterThan(340);

		// Mobile: a dark scrim sits behind the floating sheet so the page content
		// showing through its margins is dimmed and the panel reads clearly. It
		// spans the full width below the nav bar.
		const overlay = page.getByTestId('chat-overlay');
		await expect(overlay).toBeVisible();
		const overlayBox = await overlay.boundingBox();
		expect(overlayBox?.width ?? 0).toBeGreaterThan(370);

		// Desktop: the same open panel re-lays out to the anchored ~420px width.
		await page.setViewportSize({ width: 1280, height: 800 });
		await expect(panel).toBeVisible();
		const desktopBox = await panel.boundingBox();
		expect(desktopBox).not.toBeNull();
		expect(desktopBox?.width ?? 0).toBeGreaterThan(340);
		expect(desktopBox?.width ?? 0).toBeLessThan(440);

		// …and the anchored corner panel needs no scrim, so it's gone on desktop.
		await expect(overlay).toBeHidden();
	});

	test('expanding fills the viewport but never covers the nav bar', async ({
		sharedPage,
		sharedWorkspace,
	}) => {
		const page = sharedPage;

		await page.setViewportSize({ width: 1280, height: 800 });
		await page.goto(`/projects/${sharedWorkspace.projectSlug}/tasks`);
		await waitForPageLoad(page);

		const launcher = page.getByTestId('chat-launcher');
		await expect(launcher).toBeVisible({ timeout: 15000 });
		await launcher.click();

		const panel = page.getByTestId('chat-panel');
		await expect(panel).toBeVisible();

		// Anchored by default: a narrow corner panel.
		const anchored = await panel.boundingBox();
		expect(anchored?.width ?? 0).toBeLessThan(440);

		// Expand → fills the viewport width…
		await page.getByTestId('chat-expand').click();
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
		const overlay = page.getByTestId('chat-overlay');
		await expect(overlay).toBeVisible();
		const overlayBox = await overlay.boundingBox();
		expect(overlayBox?.width ?? 0).toBeGreaterThan(1200);
		expect(overlayBox?.y ?? 0).toBeGreaterThanOrEqual(headerBottom - 1);

		// Collapse restores the anchored corner panel and removes the scrim.
		await page.getByTestId('chat-expand').click();
		await expect(panel).toHaveAttribute('data-expanded', 'false');
		await expect(overlay).toBeHidden();
		const restored = await panel.boundingBox();
		expect(restored?.width ?? 0).toBeLessThan(440);
	});

	test('expanded desktop mode shows threads as a left sidebar; the dropdown is hidden', async ({
		sharedPage,
		sharedWorkspace,
	}) => {
		// Real CSS layout + viewport-conditional (decision-tree items 1 & 2): the thread
		// rail is `hidden md:flex` and only appears in expanded desktop mode, so its
		// presence and left-edge position must come from a real layout pass.
		const page = sharedPage;

		await page.setViewportSize({ width: 1280, height: 800 });
		await page.goto(`/projects/${sharedWorkspace.projectSlug}/tasks`);
		await waitForPageLoad(page);

		const launcher = page.getByTestId('chat-launcher');
		await expect(launcher).toBeVisible({ timeout: 15000 });
		await launcher.click();

		const panel = page.getByTestId('chat-panel');
		await expect(panel).toBeVisible();

		// Anchored/collapsed: the top dropdown switcher is the control; no rail.
		await expect(page.getByTestId('chat-thread-select')).toBeVisible();
		await expect(page.getByTestId('chat-thread-rail')).toBeHidden();

		// Expand → the switcher becomes a left rail and the dropdown is hidden.
		await page.getByTestId('chat-expand').click();
		await expect(panel).toHaveAttribute('data-expanded', 'true');
		const rail = page.getByTestId('chat-thread-rail');
		await expect(rail).toBeVisible();
		await expect(page.getByTestId('chat-thread-select')).toBeHidden();

		// The rail hugs the panel's left edge and is a narrow column (not full width).
		const panelBox = await panel.boundingBox();
		const railBox = await rail.boundingBox();
		expect(railBox).not.toBeNull();
		expect(Math.abs((railBox?.x ?? 0) - (panelBox?.x ?? 0))).toBeLessThan(4);
		expect(railBox?.width ?? 0).toBeLessThan(300);
		expect(railBox?.width ?? 0).toBeGreaterThan(150);

		// Collapse restores the dropdown and removes the rail.
		await page.getByTestId('chat-expand').click();
		await expect(panel).toHaveAttribute('data-expanded', 'false');
		await expect(page.getByTestId('chat-thread-select')).toBeVisible();
		await expect(rail).toBeHidden();
	});

	test('Escape closes the chat', async ({ sharedPage, sharedWorkspace }) => {
		const page = sharedPage;

		await page.setViewportSize({ width: 1280, height: 800 });
		await page.goto(`/projects/${sharedWorkspace.projectSlug}/tasks`);
		await waitForPageLoad(page);

		const launcher = page.getByTestId('chat-launcher');
		await expect(launcher).toBeVisible({ timeout: 15000 });
		await launcher.click();
		await expect(page.getByTestId('chat-panel')).toBeVisible();

		await page.keyboard.press('Escape');
		await expect(page.getByTestId('chat-panel')).toBeHidden();
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

		const launcher = page.getByTestId('chat-launcher');
		await expect(launcher).toBeVisible({ timeout: 15000 });
		await launcher.click();
		await expect(page.getByTestId('chat-panel')).toBeVisible();

		// The mobile panel is already near-full-screen, so the control is hidden.
		await expect(page.getByTestId('chat-expand')).toBeHidden();
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
		await page.route('**/api/chat/conversation', (route) =>
			route.fulfill({ json: { data: { conversation_id: 'conv-seed', messages: seeded } } }),
		);

		await page.goto(`/projects/${sharedWorkspace.projectSlug}/tasks`);
		await waitForPageLoad(page);

		const launcher = page.getByTestId('chat-launcher');
		await expect(launcher).toBeVisible({ timeout: 15000 });
		await launcher.click();

		const panel = page.getByTestId('chat-panel');
		await expect(panel).toBeVisible();
		await expect(panel).toHaveAttribute('data-expanded', 'false');

		const list = page.getByTestId('chat-messages');
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
		await page.getByTestId('chat-expand').click();
		await expect(panel).toHaveAttribute('data-expanded', 'true');
		await page.getByTestId('chat-expand').click();
		await expect(panel).toHaveAttribute('data-expanded', 'false');

		// Regression guard: each resize must re-pin the list to the bottom so the
		// newest reply stays visible. Without the fix the resize doesn't scroll and
		// the list is left where it was (top), hiding the latest message.
		await expect.poll(distanceFromBottom, { timeout: 5000 }).toBeLessThanOrEqual(8);
		await expect(page.getByText(LAST_MARKER)).toBeInViewport();
	});
});

// Kept in Playwright by decision-tree items 1 & 2 (real CSS layout + a mobile
// viewport): "did this token wrap or did it widen the panel" is a question only a
// real layout pass answers — happy-dom reports scrollWidth/clientWidth as 0 and
// never re-flows text at 375px.
test.describe('CEO chat widget — long unbreakable content', () => {
	// No spaces, far wider than the ~420px anchored panel: the pasted-link case
	// that used to push the whole message list into horizontal scroll.
	const LONG_URL =
		'https://www.linkedin.com/feed/update/urn:li:activity:7486869676694818816/?utm_source=share&utm_medium=member_desktop';

	test('a pasted link wraps inside its bubble instead of widening the message list', async ({
		sharedPage,
		sharedWorkspace,
	}) => {
		const page = sharedPage;

		const seeded = [
			{
				id: 'seed-user',
				conversation_id: 'conv-wrap',
				role: 'user',
				channel: 'web',
				status: 'complete',
				content: `i want to post: ${LONG_URL}`,
				created_at: new Date(Date.UTC(2026, 0, 1, 0, 0)).toISOString(),
			},
			{
				id: 'seed-ceo',
				conversation_id: 'conv-wrap',
				role: 'assistant',
				channel: 'web',
				status: 'complete',
				// The CEO side is markdown, so the bare URL autolinks — the anchor has
				// to wrap too, not just the plain-text user bubble.
				content: `On it. Source: ${LONG_URL}`,
				created_at: new Date(Date.UTC(2026, 0, 1, 0, 1)).toISOString(),
			},
		];

		// The widget swaps the scrollable message list for an HQ-container notice
		// unless HQ is healthy — force the instance project to "running".
		await page.route('**/api/projects', async (route) => {
			if (route.request().method() !== 'GET') return route.fallback();
			const response = await route.fetch();
			const body = (await response.json()) as { data?: Array<Record<string, unknown>> };
			const data = Array.isArray(body.data)
				? body.data.map((p) => (p.is_internal ? { ...p, container_status: 'running' } : p))
				: body.data;
			await route.fulfill({ response, json: { ...body, data } });
		});
		await page.route('**/api/chat/conversation', (route) =>
			route.fulfill({ json: { data: { conversation_id: 'conv-wrap', messages: seeded } } }),
		);

		await page.setViewportSize({ width: 1280, height: 800 });
		await page.goto(`/projects/${sharedWorkspace.projectSlug}/tasks`);
		await waitForPageLoad(page);

		const launcher = page.getByTestId('chat-launcher');
		await expect(launcher).toBeVisible({ timeout: 15000 });
		await launcher.click();
		await expect(page.getByTestId('chat-panel')).toBeVisible();

		const list = page.getByTestId('chat-messages');
		const bubbles = {
			user: page.locator('[data-testid="chat-message"][data-role="user"]'),
			ceo: page.locator('[data-testid="chat-message"][data-role="ceo"]'),
		};
		await expect(bubbles.user).toBeVisible();
		await expect(bubbles.ceo).toBeVisible();

		// Both breakpoints: the anchored desktop panel and the near-full-screen
		// mobile sheet are the two widths the bubble has to fit.
		for (const width of [1280, 375]) {
			await page.setViewportSize({ width, height: 800 });

			// The list never gains a horizontal scroll range — the bug was the URL
			// setting a min-content width wider than the panel.
			await expect
				.poll(() => list.evaluate((el) => el.scrollWidth - el.clientWidth))
				.toBeLessThanOrEqual(1);

			const listBox = await list.boundingBox();
			expect(listBox).not.toBeNull();
			for (const [role, bubble] of Object.entries(bubbles)) {
				const box = await bubble.boundingBox();
				expect(box, `${role} bubble at ${width}px`).not.toBeNull();
				if (!box || !listBox) continue;
				expect(box.x, `${role} bubble left edge at ${width}px`).toBeGreaterThanOrEqual(
					listBox.x - 1,
				);
				expect(box.x + box.width, `${role} bubble right edge at ${width}px`).toBeLessThanOrEqual(
					listBox.x + listBox.width + 1,
				);
				// Wrapped, not clipped: the URL alone spans several lines at these widths.
				expect(box.height, `${role} bubble height at ${width}px`).toBeGreaterThan(40);
			}
		}
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

		const launcher = page.getByTestId('chat-launcher');
		await expect(launcher).toBeVisible({ timeout: 15000 });
		await launcher.click();
		await expect(page.getByTestId('chat-panel')).toBeVisible();

		const input = page.getByTestId('chat-input');
		const heightOf = async () => (await input.boundingBox())?.height ?? 0;

		// Empty composer starts as a single row.
		const initialHeight = await heightOf();
		expect(initialHeight).toBeGreaterThan(0);

		// Several lines of input expand the box well past its single-row height.
		await input.fill(['one', 'two', 'three', 'four', 'five'].join('\n'));
		await expect.poll(heightOf).toBeGreaterThan(initialHeight + 20);

		// Submitting clears the draft, collapsing the composer back to one row.
		await page.getByTestId('chat-send').click();
		await expect(input).toHaveValue('');
		await expect.poll(heightOf).toBeLessThan(initialHeight + 8);
	});

	// Regression: the content height depends on the composer's width too, so a
	// width change (expand/collapse, viewport) must re-fit. Otherwise the box keeps
	// a stale height — too tall after widening, or clipping the top line after
	// narrowing. Real layout (re-wrap + scrollHeight/clientHeight), so Playwright.
	test('the composer re-fits when the panel width changes, never clipping its content', async ({
		sharedPage,
		sharedWorkspace,
	}) => {
		const page = sharedPage;

		await page.setViewportSize({ width: 1280, height: 800 });
		await page.goto(`/projects/${sharedWorkspace.projectSlug}/tasks`);
		await waitForPageLoad(page);

		const launcher = page.getByTestId('chat-launcher');
		await expect(launcher).toBeVisible({ timeout: 15000 });
		await launcher.click();
		await expect(page.getByTestId('chat-panel')).toBeVisible();

		const input = page.getByTestId('chat-input');
		// scrollHeight > clientHeight means content is taller than the box → the top
		// is clipped/scrolled out of view, which is the bug we're guarding against.
		const isClipped = () =>
			input.evaluate((el) => {
				const t = el as HTMLTextAreaElement;
				return t.scrollHeight > t.clientHeight + 1;
			});
		const heightOf = async () => (await input.boundingBox())?.height ?? 0;

		// A long line with no explicit newlines wraps to several visual rows inside
		// the narrow (~420px) anchored panel.
		await input.fill(
			'This is a long single-line message with no explicit newlines that wraps across multiple visual rows inside the narrow anchored composer panel.',
		);
		await expect.poll(heightOf).toBeGreaterThan(60);
		const narrowHeight = await heightOf();
		expect(await isClipped()).toBe(false);

		// Expanding widens the composer: the same text now fits in fewer rows, so the
		// box must shrink rather than keep its taller height.
		await page.getByTestId('chat-expand').click();
		await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-expanded', 'true');
		await expect.poll(heightOf).toBeLessThan(narrowHeight - 10);
		expect(await isClipped()).toBe(false);

		// Collapsing narrows it again: the text re-wraps to more rows, so the box must
		// grow back — without this re-fit the top line would be clipped.
		await page.getByTestId('chat-expand').click();
		await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-expanded', 'false');
		await expect.poll(heightOf).toBeGreaterThan(narrowHeight - 5);
		expect(await isClipped()).toBe(false);
	});
});
