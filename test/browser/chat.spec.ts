import { expect, test } from './fixtures';
import { waitForPageLoad } from './helpers';

// Kept in Playwright by decision-tree items 1 & 2 (real CSS layout +
// viewport-conditional behavior): the chat dock is a near-full-screen sheet on
// mobile and an anchored ~420px panel from md up. happy-dom doesn't run media
// queries against a real layout pass, so boundingBox must come from Chromium.
test.describe('chat dock — responsive layout', () => {
	test('mobile is a near-full-screen sheet; desktop is an anchored panel', async ({
		sharedPage,
		sharedWorkspace,
	}) => {
		const page = sharedPage;

		await page.setViewportSize({ width: 375, height: 800 });
		await page.goto(`/projects/${sharedWorkspace.projectSlug}/tasks`);
		await waitForPageLoad(page);

		// The launcher is the CEO monogram in the app header.
		const launcher = page.getByTestId('app-header-chat');
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
		// There is no expand mode - the anchored panel is the whole desktop chat.
		await page.setViewportSize({ width: 1280, height: 800 });
		await expect(panel).toBeVisible();
		const desktopBox = await panel.boundingBox();
		expect(desktopBox).not.toBeNull();
		expect(desktopBox?.width ?? 0).toBeGreaterThan(340);
		expect(desktopBox?.width ?? 0).toBeLessThan(440);

		// …and the anchored corner panel needs no scrim, so it's gone on desktop.
		await expect(overlay).toBeHidden();
	});

	test('Escape closes the chat', async ({ sharedPage, sharedWorkspace }) => {
		const page = sharedPage;

		await page.setViewportSize({ width: 1280, height: 800 });
		await page.goto(`/projects/${sharedWorkspace.projectSlug}/tasks`);
		await waitForPageLoad(page);

		const launcher = page.getByTestId('app-header-chat');
		await expect(launcher).toBeVisible({ timeout: 15000 });
		await launcher.click();
		await expect(page.getByTestId('chat-panel')).toBeVisible();

		await page.keyboard.press('Escape');
		await expect(page.getByTestId('chat-panel')).toBeHidden();
		await expect(launcher).toBeVisible();
	});

	// Kept in Playwright by decision-tree item 1 (real CSS layout): this is a
	// scroll-position regression, and scrollTop/scrollHeight/clientHeight only
	// carry real values under Chromium's layout engine — happy-dom returns 0.
	test('opening pins the newest message to the bottom of an overflowing list', async ({
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

		// The dock swaps the scrollable message list for an HQ-container notice
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

		const launcher = page.getByTestId('app-header-chat');
		await expect(launcher).toBeVisible({ timeout: 15000 });
		await launcher.click();

		const panel = page.getByTestId('chat-panel');
		await expect(panel).toBeVisible();

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
		await expect(page.getByText(LAST_MARKER)).toBeInViewport();
	});
});

// Kept in Playwright by decision-tree items 1 & 2 (real CSS layout + a mobile
// viewport): "did this token wrap or did it widen the panel" is a question only a
// real layout pass answers — happy-dom reports scrollWidth/clientWidth as 0 and
// never re-flows text at 375px.
test.describe('chat dock — long unbreakable content', () => {
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

		// The dock swaps the scrollable message list for an HQ-container notice
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

		const launcher = page.getByTestId('app-header-chat');
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
test.describe('chat dock — composer auto-grow', () => {
	test('the composer grows with multi-line input and collapses after submit', async ({
		sharedPage,
		sharedWorkspace,
	}) => {
		const page = sharedPage;

		await page.setViewportSize({ width: 1280, height: 800 });
		await page.goto(`/projects/${sharedWorkspace.projectSlug}/tasks`);
		await waitForPageLoad(page);

		const launcher = page.getByTestId('app-header-chat');
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
	// width change (viewport breakpoint) must re-fit. Otherwise the box keeps a
	// stale height — too tall after widening, or clipping the top line after
	// narrowing. Real layout (re-wrap + scrollHeight/clientHeight), so Playwright.
	test('the composer re-fits when the panel width changes, never clipping its content', async ({
		sharedPage,
		sharedWorkspace,
	}) => {
		const page = sharedPage;

		await page.setViewportSize({ width: 1280, height: 800 });
		await page.goto(`/projects/${sharedWorkspace.projectSlug}/tasks`);
		await waitForPageLoad(page);

		const launcher = page.getByTestId('app-header-chat');
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
		// the ~420px anchored panel.
		await input.fill(
			'This is a long single-line message with no explicit newlines that wraps across multiple visual rows inside the narrow anchored composer panel, and then keeps going a little further still.',
		);
		await expect.poll(heightOf).toBeGreaterThan(60);
		const desktopHeight = await heightOf();
		expect(await isClipped()).toBe(false);

		// The mobile sheet is narrower (~359px): the same text re-wraps to more
		// rows, so the box must grow — without the re-fit the top line would clip.
		await page.setViewportSize({ width: 375, height: 800 });
		await expect(page.getByTestId('chat-panel')).toBeVisible();
		await expect.poll(heightOf).toBeGreaterThan(desktopHeight + 4);
		expect(await isClipped()).toBe(false);

		// Back to desktop: wider again, fewer rows, the box shrinks back.
		await page.setViewportSize({ width: 1280, height: 800 });
		await expect.poll(heightOf).toBeLessThan(desktopHeight + 4);
		expect(await isClipped()).toBe(false);
	});
});

// Kept in Playwright by decision-tree item 2 (viewport-conditional behavior):
// the chat closes on navigation only in the presentation that BLOCKS the page,
// and which presentation is live depends on the viewport. happy-dom implements
// matchMedia but reports a fixed 1024px width, so the component tier can only
// reach the desktop branch (covered in
// packages/web/test/overlay-close-on-navigate.test.tsx); the mobile
// full-screen sheet needs Chromium at a real mobile viewport.
test.describe('chat dock — dismissal on navigation', () => {
	test('mobile: following "View container" leaves no sheet over the page', async ({
		sharedPage,
		sharedWorkspace,
	}) => {
		const page = sharedPage;

		// Put HQ mid-provision so the chat renders its blocked panel, whose only
		// affordance is the link out to the container page.
		await page.route('**/api/projects', async (route) => {
			const res = await route.fetch();
			const json = (await res.json()) as { data: Array<Record<string, unknown>> };
			await route.fulfill({
				response: res,
				body: JSON.stringify({
					...json,
					data: json.data.map((p) =>
						p.is_internal === true ? { ...p, container_status: 'creating' } : p,
					),
				}),
			});
		});

		await page.setViewportSize({ width: 375, height: 800 });
		await page.goto(`/projects/${sharedWorkspace.projectSlug}/tasks`);
		await waitForPageLoad(page);

		const launcher = page.getByTestId('app-header-chat');
		await expect(launcher).toBeVisible({ timeout: 15000 });
		await launcher.click();

		const panel = page.getByTestId('chat-panel');
		await expect(panel).toBeVisible();
		await panel.getByTestId('hq-container-notice-link').click();

		// The sheet and its scrim both go, and the page it navigated to is what the
		// reader is actually left looking at.
		await expect(page).toHaveURL(/\/settings\/containers$/);
		await expect(panel).toBeHidden();
		await expect(page.getByTestId('chat-overlay')).toBeHidden();
		await expect(launcher).toBeVisible();
	});
});
