// Testing decision tree, points 1 (real CSS layout / boundingBox) and 5 (a real
// WebSocket stream): the disconnect toast is driven by the live socket dropping
// on a genuine `offline` transition, and the assertions read real positions
// (top-right, below the header, clear of the bottom-right chat launcher) that
// happy-dom — which has no layout and stubs WebSocket to a no-op — cannot model.

import { expect, test } from './fixtures';

test('shows a top-right reconnecting toast when the socket drops, and clears when it heals', async ({
	sharedPage,
	sharedWorkspace,
}) => {
	const page = sharedPage;
	const context = page.context();

	// The monitor gates the disconnect toast behind "connected at least once", so
	// the app socket must have opened before we drop it. Capture the app's own
	// `/ws` socket (in dev, Vite's HMR socket is created first — filter it out by
	// URL) and its first sent frame: the client replays room subscriptions the
	// instant the socket opens, which is the deterministic "opened" signal (the
	// server sends nothing on open). Arming inside the `websocket` event — which
	// fires at socket creation, before any frame — avoids racing the frame.
	let appSocketOpened: Promise<unknown> | undefined;
	page.on('websocket', (ws) => {
		if (!appSocketOpened && /\/ws(\?|$)/.test(ws.url())) {
			appSocketOpened = ws.waitForEvent('framesent', { timeout: 20000 });
		}
	});
	await page.goto(`/projects/${sharedWorkspace.projectSlug}/tasks`);
	await expect(page.getByTestId('content-well')).toBeVisible({ timeout: 20000 });
	await expect.poll(() => Boolean(appSocketOpened), { timeout: 20000 }).toBe(true);
	await appSocketOpened;

	// Drop the network for real → the socket closes → after the ~2s debounce the
	// toast surfaces.
	await context.setOffline(true);
	const toast = page.getByTestId('connection-toast');
	await expect(toast).toBeVisible({ timeout: 10000 });
	await expect(toast).toContainText('Connection lost');
	await expect(toast).toContainText('Reconnecting');

	// Position: top-right, below the app header, and clear of the CEO chat launcher
	// (which is pinned bottom-right — the whole reason toasts moved to the top).
	const toastBox = await toast.boundingBox();
	const headerBox = await page.getByTestId('app-header').boundingBox();
	const launcherBox = await page.getByTestId('chat-launcher').boundingBox();
	const viewport = page.viewportSize();
	if (!toastBox || !headerBox || !launcherBox || !viewport) throw new Error('missing boxes');
	expect(toastBox.y).toBeGreaterThanOrEqual(headerBox.y + headerBox.height - 1);
	expect(toastBox.x + toastBox.width).toBeGreaterThan(viewport.width / 2);
	expect(toastBox.y + toastBox.height).toBeLessThan(launcherBox.y);

	// "Retry now" is a real control: clicking it while still offline forces a
	// reconnect attempt without crashing, and the toast stays up (still offline).
	await page.getByTestId('connection-retry').click();
	await expect(toast).toBeVisible();

	// Restore the network → the socket reconnects → the toast clears.
	await context.setOffline(false);
	await expect(toast).toBeHidden({ timeout: 15000 });
});
