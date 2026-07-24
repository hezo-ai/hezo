// The AppShell "can't reach the server" branch: when the /api/status probe fails
// with a browser-style network error, the shell renders a full-screen state with
// the Hezo brand mark top-left, a large message, and a "Retry now" button wired
// to refetch. Driven by failing the status fetch before the shell mounts.
import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';

test('renders the beautified unreachable screen with the logo and a Retry now button', async () => {
	// Fail the status probe with the browser's technical network error before the
	// shell mounts. `checkStatus` surfaces it verbatim, so AppShell takes its
	// network-error branch (the message is normalised to the friendly copy).
	const passthrough = globalThis.fetch;
	let statusFetches = 0;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url =
			typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
		if (new URL(url, 'http://localhost').pathname === '/api/status') {
			statusFetches += 1;
			throw new TypeError('Failed to fetch');
		}
		return passthrough(input as RequestInfo, init);
	}) as typeof globalThis.fetch;

	try {
		const { findByTestId, findByText, findByRole, getByAltText, user } = await renderApp({
			initialPath: '/',
		});

		await findByTestId('server-unreachable');
		// Friendly, normalised copy — never the raw "Failed to fetch".
		await findByText(/Can't reach the server/i);
		// Brand mark pinned top-left, mirroring where the logo sits in the app chrome.
		getByAltText('Hezo');

		// The former "Retry" link is now a real button labelled "Retry now", wired
		// to refetch the status.
		const retry = await findByRole('button', { name: /retry now/i });
		const before = statusFetches;
		await user.click(retry);
		await waitFor(() => expect(statusFetches).toBeGreaterThan(before));
	} finally {
		globalThis.fetch = passthrough;
	}
});
