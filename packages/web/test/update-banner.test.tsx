import { UpdateState } from '@hezo/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { UpdateBanner } from '../src/components/update-banner';
import type { UpdateStatusInfo } from '../src/hooks/use-update-check';
import { api } from '../src/lib/api';

const BASE: UpdateStatusInfo = {
	current: '0.1.0',
	latest: '0.2.0',
	updateAvailable: true,
	url: 'https://github.com/hezo-ai/hezo/releases/0.2.0',
	state: UpdateState.Staged,
	targetVersion: '0.2.0',
	error: null,
	autoUnlock: false,
	canApply: true,
};

function today(): string {
	return new Date().toLocaleDateString('en-CA');
}

function renderBanner(status: Partial<UpdateStatusInfo> = {}, isSuperuser = true) {
	// staleTime: Infinity stops the seeded queries (incl. `me`) from refetching on
	// mount — otherwise a mocked api.get feeds `useMe` the wrong shape and the
	// canApply button unmounts mid-click.
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
	});
	// Seed both caches so the component renders without hitting the network.
	qc.setQueryData(['update-status'], { ...BASE, ...status });
	qc.setQueryData(['me'], { type: 'admin', is_superuser: isSuperuser });
	return {
		qc,
		...render(
			<QueryClientProvider client={qc}>
				<UpdateBanner />
			</QueryClientProvider>,
		),
	};
}

afterEach(() => {
	localStorage.clear();
	vi.restoreAllMocks();
});

test('hidden when no update is available', () => {
	const { queryByTestId } = renderBanner({ updateAvailable: false, latest: '0.1.0' });
	expect(queryByTestId('update-banner')).toBeNull();
});

test('non-superuser / non-supervised falls back to a release download link', () => {
	const { getByTestId, getByText, queryByTestId } = renderBanner({ canApply: false }, false);
	expect(getByTestId('update-banner')).toBeTruthy();
	expect(queryByTestId('update-restart-button')).toBeNull();
	const link = getByText('Download') as HTMLAnchorElement;
	expect(link.getAttribute('href')).toBe('https://github.com/hezo-ai/hezo/releases/0.2.0');
});

test('the version number links to its GitHub release page', () => {
	const { getByTestId } = renderBanner();
	const link = getByTestId('update-version-link') as HTMLAnchorElement;
	expect(link.textContent).toBe('0.2.0');
	expect(link.getAttribute('href')).toBe('https://github.com/hezo-ai/hezo/releases/0.2.0');
});

test('supervised + superuser shows an "Install & restart" button when staged', () => {
	const { getByTestId } = renderBanner({ state: UpdateState.Staged });
	const button = getByTestId('update-restart-button');
	expect(button.textContent).toContain('Install & restart');
});

test('banner stays hidden while the background download is in flight', () => {
	for (const state of [UpdateState.Idle, UpdateState.Checking, UpdateState.Downloading] as const) {
		const { queryByTestId, unmount } = renderBanner({ state });
		expect(queryByTestId('update-banner')).toBeNull();
		unmount();
	}
});

test('a staging error on a self-applying instance offers a retry (with a manual link)', () => {
	const { getByTestId, getByText, queryByTestId } = renderBanner({ state: UpdateState.Error });
	expect(getByTestId('update-banner')).toBeTruthy();
	// No instant-restart button — the staged binary never landed.
	expect(queryByTestId('update-restart-button')).toBeNull();
	// The retry button re-triggers the background download; the release page stays
	// available as a secondary fallback.
	expect(getByTestId('update-retry-button').textContent).toContain('Retry download');
	const link = getByText('Download manually') as HTMLAnchorElement;
	expect(link.getAttribute('href')).toBe('https://github.com/hezo-ai/hezo/releases/0.2.0');
});

test('retry posts to the download route to re-stage', async () => {
	const user = userEvent.setup();
	const postSpy = vi
		.spyOn(api, 'post')
		.mockResolvedValue({ data: { state: UpdateState.Downloading, targetVersion: '0.2.0' } });
	// onSuccess invalidates the status query; stub the refetch so it doesn't hit the network.
	vi.spyOn(api, 'get').mockResolvedValue({ ...BASE, state: UpdateState.Downloading });
	const { getByTestId } = renderBanner({ state: UpdateState.Error });
	await user.click(getByTestId('update-retry-button'));
	await waitFor(() => expect(postSpy).toHaveBeenCalledWith('/api/updates/download'));
});

test('Install & restart asks for confirmation (with master-key warning) before applying', async () => {
	const user = userEvent.setup();
	const postSpy = vi
		.spyOn(api, 'post')
		.mockResolvedValue({ state: UpdateState.Applying, targetVersion: '0.2.0' });

	const { getByTestId, findByTestId, queryByTestId } = renderBanner();

	// Already staged: clicking the action opens the dialog — it does NOT apply yet.
	await user.click(getByTestId('update-restart-button'));
	const dialog = await findByTestId('confirm-dialog');
	expect(dialog.textContent).toContain('master key');
	expect(postSpy).not.toHaveBeenCalled();
	expect(queryByTestId('update-restart-overlay')).toBeNull();

	// Confirming applies and mounts the restart overlay.
	await user.click(getByTestId('confirm-dialog-confirm'));
	await waitFor(() => expect(postSpy).toHaveBeenCalledWith('/api/updates/apply'));
	expect(await findByTestId('update-restart-overlay')).toBeTruthy();
});

test('confirmation omits the master-key warning when the instance auto-unlocks', async () => {
	const user = userEvent.setup();
	vi.spyOn(api, 'post').mockResolvedValue({ state: UpdateState.Applying, targetVersion: '0.2.0' });
	const { getByTestId, findByTestId } = renderBanner({ autoUnlock: true });
	await user.click(getByTestId('update-restart-button'));
	const dialog = await findByTestId('confirm-dialog');
	expect(dialog.textContent).not.toContain('master key');
});

test('dismiss hides the banner for the rest of the day and records version + day', async () => {
	const user = userEvent.setup();
	const { getByTestId, queryByTestId, getByLabelText } = renderBanner();
	expect(getByTestId('update-banner')).toBeTruthy();
	await user.click(getByLabelText('Dismiss update notification'));
	expect(queryByTestId('update-banner')).toBeNull();
	const stored = JSON.parse(localStorage.getItem('hezo:update-dismissed') ?? 'null');
	expect(stored).toEqual({ version: '0.2.0', day: today() });
});

test("today's dismissal of the current version keeps it hidden", () => {
	localStorage.setItem('hezo:update-dismissed', JSON.stringify({ version: '0.2.0', day: today() }));
	const { queryByTestId } = renderBanner();
	expect(queryByTestId('update-banner')).toBeNull();
});

test('a dismissal from a previous day no longer suppresses the banner', () => {
	localStorage.setItem(
		'hezo:update-dismissed',
		JSON.stringify({ version: '0.2.0', day: '2000-01-01' }),
	);
	const { getByTestId } = renderBanner();
	expect(getByTestId('update-banner')).toBeTruthy();
});

test("today's dismissal of an older version does not suppress a newer one", () => {
	localStorage.setItem('hezo:update-dismissed', JSON.stringify({ version: '0.1.9', day: today() }));
	const { getByTestId } = renderBanner(); // latest is 0.2.0
	expect(getByTestId('update-banner')).toBeTruthy();
});

test('a legacy bare-version dismissal is ignored (banner shows)', () => {
	localStorage.setItem('hezo:update-dismissed', '0.2.0');
	const { getByTestId } = renderBanner();
	expect(getByTestId('update-banner')).toBeTruthy();
});

test('surfaces "Install & restart" once a background download stages — via polling, no reload', async () => {
	// Off the settings page the banner is the only status observer, so its own `poll: true`
	// has to carry it through the background download. The server returns `idle` first (stage
	// not yet written), then `staged`; the banner must advance from hidden to the instant-
	// restart button live instead of staying hidden until the user reloads.
	vi.spyOn(api, 'get')
		.mockResolvedValueOnce({ ...BASE, state: UpdateState.Idle })
		.mockResolvedValue({ ...BASE, state: UpdateState.Staged });
	const qc = new QueryClient({
		// refetchIntervalInBackground: the happy-dom document isn't "focused", so react-query
		// would otherwise skip the interval poll a real (focused) browser runs.
		defaultOptions: {
			queries: {
				retry: false,
				staleTime: Number.POSITIVE_INFINITY,
				refetchIntervalInBackground: true,
			},
		},
	});
	qc.setQueryData(['me'], { type: 'admin', is_superuser: true });
	const { findByTestId, queryByTestId } = render(
		<QueryClientProvider client={qc}>
			<UpdateBanner />
		</QueryClientProvider>,
	);

	// Mid-download the banner is hidden (no data yet / `idle`).
	expect(queryByTestId('update-banner')).toBeNull();

	// The interval poll advances idle → staged and the banner appears with the restart button.
	const button = await findByTestId('update-restart-button', undefined, { timeout: 5000 });
	expect(button.textContent).toContain('Install & restart');
	expect(queryByTestId('update-banner')).toBeTruthy();
});
