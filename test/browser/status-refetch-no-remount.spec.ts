// Testing decision tree, point 5 (real network/WebSocket reconnect behaviour):
// this reproduces a mobile-only symptom that needs genuine `offline`→`online`
// transitions (which flip `navigator.onLine` and fire the browser events React
// Query's onlineManager listens to) plus observation of the app tree
// mounting/unmounting across an in-flight fetch window. happy-dom can neither
// fire those transitions nor model the reconnect refetch, so it lives here.
//
// The bug: AppShell (`packages/web/src/routes/__root.tsx`) gated its full-screen
// spinner on `isFetching`, which is true during ANY `useStatus()` fetch — not
// just the first load. `useStatus` has `staleTime: 0` and inherits React Query's
// default `refetchOnReconnect: true`, so every network blip (constant on mobile:
// radio sleep on app-switch, cell↔wifi handoffs, signal dips) refetched status,
// flipped `isFetching`, and unmounted the whole `<SocketProvider>/<ShellLayout>`
// tree behind the spinner — which reads as a spontaneous full-page refresh. The
// fix gates the spinner on `isPending` (initial load only); background refetches
// must keep the shell mounted.

import { expect, test } from './fixtures';

test('does not blank the shell to a spinner when status refetches on reconnect', async ({
	sharedPage,
	sharedWorkspace,
}) => {
	const page = sharedPage;
	const context = page.context();

	// Load the shell fully first so the initial status fetch is already resolved —
	// only a *background* refetch should be under test.
	await page.goto(`/projects/${sharedWorkspace.projectSlug}/tasks`);
	const contentWell = page.getByTestId('content-well');
	await expect(contentWell).toBeVisible({ timeout: 20000 });

	// Hold the reconnect-triggered status refetch in flight long enough to observe
	// whether the shell stays mounted. Only added now, so the initial load above
	// wasn't delayed.
	await page.route('**/api/status', async (route) => {
		await new Promise((r) => setTimeout(r, 2500));
		await route.continue();
	});

	// A real offline→online transition: `navigator.onLine` flips and the browser
	// fires `offline` then `online`, exactly the mobile network blip. React Query's
	// onlineManager reacts to `online` and, because the status query is stale and
	// refetch-on-reconnect is on, refetches it — the request our route now delays.
	const statusRefetch = page.waitForRequest(
		(req) => req.url().includes('/api/status') && req.method() === 'GET',
		{ timeout: 15000 },
	);
	await context.setOffline(true);
	await context.setOffline(false);
	await statusRefetch;

	// The status refetch is now in flight and stays so for ~2.5s. Before the fix
	// the shell had already been replaced by the full-screen spinner for that whole
	// window (content-well detached); after the fix it stays mounted. A short
	// timeout keeps this assertion inside the in-flight window.
	await expect(contentWell).toBeVisible({ timeout: 1500 });
});
