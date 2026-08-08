// The AppShell "can't reach the server" branch: when the /api/status probe fails
// with a browser-style network error, the shell renders a full-screen state with
// the Hezo brand mark top-left, a large message (no "Retrying…" suffix), and a
// Retry-now button that relabels to "Retrying…" and disables while the refetch it
// fires is in flight. Once the probe has errored, the screen must stay mounted
// through retries rather than blanking to the boot spinner.
import { act, render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { I18nProvider } from '../src/lib/i18n';
import { UnreachableScreen } from '../src/routes/__root';
import { renderApp } from './helpers/render';

test('unreachable screen: no "Retrying…" copy, Retry-now stays mounted + in flight', async () => {
	const passthrough = globalThis.fetch;
	let statusFetches = 0;
	// When armed (just before the click) the next status fetch hangs until released,
	// so the in-flight retry can be observed.
	let hold: Promise<void> | null = null;
	let releaseHold: () => void = () => {};
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url =
			typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
		if (new URL(url, 'http://localhost').pathname === '/api/status') {
			statusFetches += 1;
			if (hold) await hold;
			throw new TypeError('Failed to fetch');
		}
		return passthrough(input as RequestInfo, init);
	}) as typeof globalThis.fetch;

	try {
		const { findByTestId, findByText, findByRole, getByAltText, queryByText, queryByTestId, user } =
			await renderApp({ initialPath: '/' });

		await findByTestId('server-unreachable');
		// Friendly copy with the "Retrying…" suffix dropped.
		await findByText("Can't reach the server.");
		expect(queryByText(/retrying/i)).toBeNull();
		// Brand mark pinned top-left, mirroring where the logo sits in the app chrome.
		getByAltText('Hezo');

		const retry = await findByRole('button', { name: /retry now/i });

		// Hold the next retry open, click, then confirm the screen stays mounted
		// (does NOT blank to the boot spinner) and the button reflects the in-flight
		// retry — relabelled to "Retrying…" and disabled — with a fetch actually fired.
		hold = new Promise<void>((resolve) => {
			releaseHold = resolve;
		});
		const before = statusFetches;
		await user.click(retry);

		const retrying = await findByRole('button', { name: /retrying/i });
		expect((retrying as HTMLButtonElement).disabled).toBe(true);
		expect(queryByTestId('server-unreachable')).not.toBeNull();
		expect(statusFetches).toBeGreaterThan(before);

		// Release the fetch (it fails); the button returns to an enabled "Retry now".
		hold = null;
		releaseHold();
		const back = await findByRole('button', { name: /retry now/i });
		await waitFor(() => expect((back as HTMLButtonElement).disabled).toBe(false));
	} finally {
		globalThis.fetch = passthrough;
	}
});

test('Retry-now relabels to "Retrying…" and disables while the retry is in flight', async () => {
	// Component-level check of the button's pending state, with the retry promise
	// held open deterministically.
	let release: () => void = () => {};
	const onRetry = vi.fn(
		() =>
			new Promise<void>((resolve) => {
				release = resolve;
			}),
	);
	const user = userEvent.setup();
	const { getByRole } = render(
		<I18nProvider>
			<UnreachableScreen message="Can't reach the server." isNetwork onRetry={onRetry} />
		</I18nProvider>,
	);

	const btn = getByRole('button', { name: /retry now/i }) as HTMLButtonElement;
	expect(btn.disabled).toBe(false);

	await user.click(btn);

	const retrying = getByRole('button', { name: /retrying/i }) as HTMLButtonElement;
	expect(retrying.disabled).toBe(true);
	expect(onRetry).toHaveBeenCalledTimes(1);

	await act(async () => {
		release();
	});
	const back = getByRole('button', { name: /retry now/i }) as HTMLButtonElement;
	expect(back.disabled).toBe(false);
});
