import { expect, test } from './fixtures';
import { waitForPageLoad } from './helpers';

// Kept in Playwright by decision-tree items 1 & 2 (real CSS layout +
// viewport-conditional behavior): the chat dock is a near-full-screen sheet on
// mobile and a full-height ~420px rail down the right edge from md up.
// happy-dom doesn't run media queries against a real layout pass, so
// boundingBox must come from Chromium.
test.describe('chat dock — responsive layout', () => {
	test('mobile is a near-full-screen sheet; desktop is a full-height right rail', async ({
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

		// Desktop: the same open panel re-lays out to the ~420px rail.
		await page.setViewportSize({ width: 1280, height: 800 });
		await expect(panel).toBeVisible();
		// setViewportSize does not block on the re-layout, so measuring straight
		// after it can still read the mobile sheet. That went unnoticed for as long
		// as the only desktop assertions were `width > 340` and `width < 440`: the
		// 359px mobile sheet satisfies both, so the whole desktop half of this test
		// passed on a stale box. Poll on the one number that separates the two
		// layouts - the sheet's top is 64px, the rail's is 48px - before measuring.
		await expect.poll(async () => (await panel.boundingBox())?.y ?? -1).toBeLessThanOrEqual(56);
		const desktopBox = await panel.boundingBox();
		expect(desktopBox).not.toBeNull();
		expect(desktopBox?.width ?? 0).toBeGreaterThan(340);
		expect(desktopBox?.width ?? 0).toBeLessThan(440);

		// It starts BELOW the h-12 (48px) shell header, so the top bar stays
		// reachable while chat is open, and runs to the bottom of the viewport.
		// This is the whole claim of "rail" over "corner panel", and only a real
		// layout pass can say it.
		expect(desktopBox?.y ?? 0).toBeGreaterThanOrEqual(40);
		expect(desktopBox?.height ?? 0).toBeGreaterThan(700);

		// …and it is flush to the right edge rather than inset from the corner.
		// Tolerant of a scrollbar gutter; the old panel sat 16px in AND 16px up.
		expect((desktopBox?.x ?? 0) + (desktopBox?.width ?? 0)).toBeGreaterThan(1260);

		// The rail is a persistent companion, not a modal, so no scrim on desktop.
		await expect(overlay).toBeHidden();

		// The resize handle is desktop-only. Only its presence and side are real
		// layout facts; the drag arithmetic, the viewport clamp and persistence
		// are deterministic and covered in packages/web/test/resizable-split.test.tsx,
		// so they do not pay for a browser.
		const handle = page.getByTestId('chat-rail-resize');
		await expect(handle).toBeVisible();
		const handleBox = await handle.boundingBox();
		// On the rail's inner (page-facing) edge, not its outer one.
		expect(handleBox?.x ?? 0).toBeLessThan((desktopBox?.x ?? 0) + 20);
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

		// A real CEO reply needs a container + a live LLM, so mock the read
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
// viewport): maximizing is a geometry change - the full width below the header on
// desktop, edge to edge over it on a phone - and the reading column and the
// composer's taller cap are sizes only a real layout pass reports. The state
// around it (the toggle, Escape, reopening at the rail) is in
// packages/web/test/chat.test.tsx.
test.describe('chat dock — maximized', () => {
	// Far taller than either composer cap, so the box stops at the cap and the
	// measured height IS the cap.
	const LONG_DRAFT = Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of a long message.`).join(
		'\n',
	);

	test('desktop: fills the page below the header, reads in a centered column, then restores', async ({
		sharedPage,
		sharedWorkspace,
	}) => {
		const page = sharedPage;
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.goto(`/projects/${sharedWorkspace.projectSlug}/tasks`);
		await waitForPageLoad(page);

		const launcher = page.getByTestId('app-header-chat');
		await expect(launcher).toBeVisible({ timeout: 15000 });
		await launcher.click();

		const panel = page.getByTestId('chat-panel');
		const width = async () => (await panel.boundingBox())?.width ?? 0;
		await expect(panel).toBeVisible();
		await expect.poll(width).toBeLessThan(440);

		// In the rail the composer stops at its 8rem (128px) cap and scrolls.
		const input = page.getByTestId('chat-input');
		const inputHeight = async () => (await input.boundingBox())?.height ?? 0;
		await input.fill(LONG_DRAFT);
		await expect.poll(inputHeight).toBeGreaterThan(100);
		expect(await inputHeight()).toBeLessThanOrEqual(129);

		await page.getByTestId('chat-maximize').click();
		await expect(panel).toHaveAttribute('data-maximized', 'true');
		// The panel motion carries the width, so wait for it to settle.
		await expect.poll(width).toBeGreaterThan(1430);
		const box = await panel.boundingBox();
		expect(box).not.toBeNull();
		expect(box?.x ?? -1).toBeLessThanOrEqual(1);
		// Still below the h-12 (48px) header, so the top bar stays reachable,
		// and running to the bottom of the viewport.
		expect(box?.y ?? 0).toBeGreaterThanOrEqual(47);
		expect(box?.y ?? 0).toBeLessThanOrEqual(49);
		expect((box?.y ?? 0) + (box?.height ?? 0)).toBeGreaterThan(898);
		// A maximized dock has no inner edge to drag.
		await expect(page.getByTestId('chat-rail-resize')).toHaveCount(0);

		// The thread and the composer read in a 52rem (832px) column, centered:
		// equal gutters either side instead of lines running the full 1440px.
		const contentBox = (testId: string) =>
			page.getByTestId(testId).evaluate((el) => {
				const s = getComputedStyle(el);
				const left = Number.parseFloat(s.paddingLeft);
				const right = Number.parseFloat(s.paddingRight);
				return { left, right, content: el.clientWidth - left - right };
			});
		const composer = await contentBox('chat-composer');
		expect(composer.left).toBeCloseTo(composer.right, 0);
		expect(composer.content).toBeCloseTo(832, 0);
		// The message list may lose a scrollbar's width from its column.
		const thread = await contentBox('chat-messages');
		expect(thread.left).toBeCloseTo(thread.right, 0);
		expect(thread.content).toBeGreaterThan(800);
		expect(thread.content).toBeLessThanOrEqual(833);

		// The composer may now grow to 40% of the viewport before it scrolls.
		await expect.poll(inputHeight).toBeGreaterThan(300);
		expect(await inputHeight()).toBeLessThanOrEqual(0.4 * 900 + 1);

		// The same button restores the rail, its width and its composer cap.
		await page.getByTestId('chat-maximize').click();
		await expect(panel).toHaveAttribute('data-maximized', 'false');
		await expect.poll(width).toBeLessThan(440);
		await expect.poll(inputHeight).toBeLessThanOrEqual(129);
		await expect(page.getByTestId('chat-rail-resize')).toBeVisible();
	});

	test('mobile: covers the whole screen, header included, then restores to the sheet', async ({
		sharedPage,
		sharedWorkspace,
	}) => {
		const page = sharedPage;
		await page.setViewportSize({ width: 375, height: 800 });
		await page.goto(`/projects/${sharedWorkspace.projectSlug}/tasks`);
		await waitForPageLoad(page);

		const launcher = page.getByTestId('app-header-chat');
		await expect(launcher).toBeVisible({ timeout: 15000 });
		await launcher.click();

		const panel = page.getByTestId('chat-panel');
		const top = async () => (await panel.boundingBox())?.y ?? -1;
		await expect(panel).toBeVisible();
		// The sheet: 64px down, clear of the header.
		await expect.poll(top).toBeGreaterThanOrEqual(60);

		await page.getByTestId('chat-maximize').click();
		await expect(panel).toHaveAttribute('data-maximized', 'true');
		await expect.poll(top).toBeLessThanOrEqual(0.5);
		const box = await panel.boundingBox();
		expect(box?.x ?? -1).toBeLessThanOrEqual(0.5);
		expect(box?.width ?? 0).toBeGreaterThanOrEqual(374);
		expect(box?.height ?? 0).toBeGreaterThanOrEqual(799);
		// Over the header, not under it: the top-left corner, where the header
		// draws, now hits the panel.
		const cornerHitsPanel = await page.evaluate(
			() => document.elementFromPoint(20, 20)?.closest('[data-testid="chat-panel"]') != null,
		);
		expect(cornerHitsPanel).toBe(true);

		// The composer may grow past the sheet's 8rem cap.
		const input = page.getByTestId('chat-input');
		const inputHeight = async () => (await input.boundingBox())?.height ?? 0;
		await input.fill(LONG_DRAFT);
		await expect.poll(inputHeight).toBeGreaterThan(200);

		await page.getByTestId('chat-maximize').click();
		await expect(panel).toHaveAttribute('data-maximized', 'false');
		await expect.poll(top).toBeGreaterThanOrEqual(60);
		await expect.poll(inputHeight).toBeLessThanOrEqual(129);
	});

	test('mobile: the header keeps all four buttons in the sheet beside the longest room name', async ({
		sharedPage,
		sharedWorkspace,
	}) => {
		// The maximize button is the header's fourth, on the narrowest sheet
		// (359px). The room title truncates; the buttons must not be pushed out.
		const page = sharedPage;
		await page.setViewportSize({ width: 375, height: 800 });
		await page.goto(`/projects/${sharedWorkspace.projectSlug}/tasks`);
		await waitForPageLoad(page);

		const launcher = page.getByTestId('app-header-chat');
		await expect(launcher).toBeVisible({ timeout: 15000 });
		await launcher.click();
		const panel = page.getByTestId('chat-panel');
		await expect(panel).toBeVisible();

		const longest = sharedWorkspace.agents
			.map((a) => a.title)
			.reduce((a, b) => (b.length > a.length ? b : a));
		await page.getByTestId('chat-room-select-button').click();
		await page
			.getByTestId('chat-room-select-content')
			.getByRole('option', { name: longest, exact: true })
			.click();
		await expect(page.getByTestId('chat-room-title')).toHaveText(longest);

		const header = panel.locator('header');
		expect(await header.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
		const panelBox = await panel.boundingBox();
		for (const id of ['chat-new-group', 'chat-copy', 'chat-maximize', 'chat-close']) {
			const box = await page.getByTestId(id).boundingBox();
			expect(box, id).not.toBeNull();
			expect((box?.x ?? 0) + (box?.width ?? 0), id).toBeLessThanOrEqual(
				(panelBox?.x ?? 0) + (panelBox?.width ?? 0),
			);
		}
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

	test('a long task breadcrumb wraps inside the thread instead of running past the panel edge', async ({
		sharedPage,
		sharedWorkspace,
	}) => {
		const page = sharedPage;
		// The breadcrumb pills carry a task's whole title, and a title has no
		// length limit. Short ones keep the one-line centred pill.
		const LONG_TITLE =
			'Research one-page reports for new crypto holdings and reconcile them against the portfolio';
		const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
		const seeded = [
			{
				id: 'seed-user',
				conversation_id: 'conv-crumbs',
				role: 'user',
				channel: 'web',
				status: 'complete',
				content: 'Set the research up, please.',
				created_at: at(0),
			},
			{
				id: 'seed-created',
				conversation_id: 'conv-crumbs',
				role: 'system',
				system_kind: 'task_created',
				channel: 'web',
				status: 'complete',
				content: `Created task INV-375 in Investments: ${LONG_TITLE}`,
				created_at: at(1),
			},
			{
				id: 'seed-done',
				conversation_id: 'conv-crumbs',
				role: 'system',
				system_kind: 'task_completed',
				channel: 'web',
				status: 'complete',
				content: 'Task INV-376 completed: Render HTML',
				created_at: at(2),
			},
		];
		await page.route('**/api/chat/conversation', (route) =>
			route.fulfill({ json: { data: { conversation_id: 'conv-crumbs', messages: seeded } } }),
		);

		await page.setViewportSize({ width: 1280, height: 800 });
		await page.goto(`/projects/${sharedWorkspace.projectSlug}/tasks`);
		await waitForPageLoad(page);
		const launcher = page.getByTestId('app-header-chat');
		await expect(launcher).toBeVisible({ timeout: 15000 });
		await launcher.click();

		const list = page.getByTestId('chat-messages');
		const crumb = (kind: string) =>
			page.locator(`[data-testid="chat-message"][data-system-kind="${kind}"] > span`).nth(1);
		const long = crumb('task_created');
		const short = crumb('task_completed');
		await expect(long).toBeVisible();
		await expect(short).toBeVisible();

		// The anchored rail and the phone sheet are the two widths it has to fit.
		for (const width of [1280, 375]) {
			await page.setViewportSize({ width, height: 800 });
			await expect
				.poll(() => list.evaluate((el) => el.scrollWidth - el.clientWidth))
				.toBeLessThanOrEqual(1);

			const listBox = await list.boundingBox();
			const longBox = await long.boundingBox();
			expect(listBox).not.toBeNull();
			expect(longBox).not.toBeNull();
			if (!listBox || !longBox) continue;
			expect(longBox.x, `long pill left edge at ${width}px`).toBeGreaterThanOrEqual(listBox.x - 1);
			expect(longBox.x + longBox.width, `long pill right edge at ${width}px`).toBeLessThanOrEqual(
				listBox.x + listBox.width + 1,
			);
			// The whole title is shown - wrapped onto more lines, not cut or
			// ellipsised: nothing inside the pill overflows its box.
			expect(
				await long.evaluate((el) =>
					[el, ...Array.from(el.querySelectorAll('*'))].every(
						(n) => n.scrollWidth <= n.clientWidth + 1,
					),
				),
				`long pill text fully shown at ${width}px`,
			).toBe(true);
			expect(longBox.height, `long pill wraps at ${width}px`).toBeGreaterThan(30);

			// A short one stays a single centred line.
			const shortBox = await short.boundingBox();
			expect(shortBox?.height ?? 0, `short pill height at ${width}px`).toBeLessThan(26);
			const gutterLeft = (shortBox?.x ?? 0) - listBox.x;
			const gutterRight = listBox.x + listBox.width - ((shortBox?.x ?? 0) + (shortBox?.width ?? 0));
			expect(Math.abs(gutterLeft - gutterRight), `short pill centred at ${width}px`).toBeLessThan(
				20,
			);
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
		// the ~420px anchored panel - long enough to re-wrap measurably at the
		// narrower mobile width, short enough to stay under the composer's
		// max-height cap there (past the cap it scrolls by design, which would
		// read as "clipped" and fail the guard for the wrong reason).
		await input.fill(
			'This is a long single-line message with no explicit newlines that wraps across multiple visual rows inside the narrow anchored composer panel.',
		);
		await expect.poll(heightOf).toBeGreaterThan(60);
		const desktopHeight = await heightOf();
		expect(await isClipped()).toBe(false);

		// The mobile sheet is narrower (~359px): the same text re-wraps to more
		// rows, so the box must re-fit — without it the top line clips, which is
		// exactly what `isClipped` catches (a stale height leaves scrollHeight
		// above clientHeight). The clip check, not a row-count delta, is the
		// assertion: how many extra rows the re-wrap costs depends on font
		// metrics, so a numeric height bound would flake across renderers.
		await page.setViewportSize({ width: 375, height: 800 });
		await expect(page.getByTestId('chat-panel')).toBeVisible();
		await expect.poll(heightOf).toBeGreaterThanOrEqual(desktopHeight);
		expect(await isClipped()).toBe(false);

		// Back to desktop: wider again, the box re-fits down and still fits.
		await page.setViewportSize({ width: 1280, height: 800 });
		await expect.poll(heightOf).toBeLessThanOrEqual(desktopHeight + 1);
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
	test('mobile: following an in-chat link leaves no sheet over the page', async ({
		sharedPage,
		sharedWorkspace,
	}) => {
		const page = sharedPage;

		// A system row whose text names a run: RunLinkedText renders it as a
		// client-side link - the in-sheet affordance that navigates. (The old HQ
		// container gate is gone; a chat turn claims its own pool container, so
		// nothing in the sheet blocks on container state any more.)
		const seeded = [
			{
				id: 'seed-user',
				conversation_id: 'conv-nav',
				role: 'user',
				channel: 'web',
				status: 'complete',
				content: 'Where did that run end up?',
				created_at: new Date(Date.UTC(2026, 0, 1, 0, 0)).toISOString(),
			},
			{
				id: 'seed-wait',
				conversation_id: 'conv-nav',
				role: 'system',
				system_kind: 'credential_wait',
				channel: 'web',
				status: 'complete',
				content: `Waiting for [growth-analyst/HM-336](/projects/${sharedWorkspace.projectSlug}/agents/growth-analyst/executions/run-nav-1).`,
				created_at: new Date(Date.UTC(2026, 0, 1, 0, 1)).toISOString(),
			},
		];
		await page.route('**/api/chat/conversation', (route) =>
			route.fulfill({ json: { data: { conversation_id: 'conv-nav', messages: seeded } } }),
		);

		await page.setViewportSize({ width: 375, height: 800 });
		await page.goto(`/projects/${sharedWorkspace.projectSlug}/tasks`);
		await waitForPageLoad(page);

		const launcher = page.getByTestId('app-header-chat');
		await expect(launcher).toBeVisible({ timeout: 15000 });
		await launcher.click();

		const panel = page.getByTestId('chat-panel');
		await expect(panel).toBeVisible();
		await panel.getByTestId('run-link').click();

		// The sheet and its scrim both go, and the page it navigated to is what the
		// reader is actually left looking at.
		await expect(page).toHaveURL(/\/executions\/run-nav-1$/);
		await expect(panel).toBeHidden();
		await expect(page.getByTestId('chat-overlay')).toBeHidden();
		await expect(launcher).toBeVisible();
	});
});
