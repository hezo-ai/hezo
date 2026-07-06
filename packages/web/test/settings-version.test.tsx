import { UpdateState } from '@hezo/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { VersionDisplay } from '../src/components/version-display';
import type { UpdateStatusInfo } from '../src/hooks/use-update-check';
import { api } from '../src/lib/api';
import { queryClient } from '../src/lib/query-client';
import { queryKeys } from '../src/lib/query-keys';
import { renderApp } from './helpers/render';

// The General settings page reads version + staged-update lifecycle via
// useUpdateStatus(); the app tree pulls from the singleton query client (__root
// re-wraps with it), so seed that cache to render the version display
// deterministically without an upstream GitHub call.
function seedVersion(update: {
	current: string;
	latest?: string | null;
	updateAvailable?: boolean;
	url?: string | null;
}) {
	queryClient.setQueryData(queryKeys.updateStatus(), {
		current: update.current,
		latest: update.latest ?? null,
		updateAvailable: update.updateAvailable ?? false,
		url: update.url ?? null,
		state: UpdateState.Idle,
		targetVersion: null,
		error: null,
		autoUnlock: true,
		canApply: false,
	} satisfies UpdateStatusInfo);
}

test('general settings page shows the version and links to its GitHub release tag', async () => {
	seedVersion({ current: '0.2.0' });
	const { findByTestId } = await renderApp({ initialPath: '/settings' });

	const section = await findByTestId('settings-version');
	expect(section.textContent).toContain('Current version:');
	expect(section.textContent).toContain('0.2.0');

	const releaseLink = section.querySelector(
		'a[href="https://github.com/hezo-ai/hezo/releases/tag/0.2.0"]',
	) as HTMLAnchorElement | null;
	expect(releaseLink).toBeTruthy();
	expect(releaseLink?.textContent).toContain('0.2.0');
});

test('general settings page links a non-release version to the releases index (no broken tag link)', async () => {
	seedVersion({ current: '0.0.0-dev' });
	const { findByTestId } = await renderApp({ initialPath: '/settings' });

	const section = await findByTestId('settings-version');
	expect(section.textContent).toContain('0.0.0-dev');
	// No release-tag link for a non-release version; it points at the releases index instead.
	expect(section.querySelector('a[href*="/releases/tag/"]')).toBeNull();
	expect(section.querySelector('a[href="https://github.com/hezo-ai/hezo/releases"]')).toBeTruthy();
});

test('check-for-new-version button posts a fresh check and reports the result', async () => {
	seedVersion({ current: '0.2.0' });
	const { findByTestId, user } = await renderApp({ initialPath: '/settings' });

	// The server's /api/updates/check returns the same release the test backend has;
	// clicking the button seeds the cache with that response and renders the result.
	const button = await findByTestId('settings-version-check');
	await user.click(button);

	const result = await findByTestId('settings-version-result');
	expect(result.textContent).toMatch(/latest version|is available/);
});

test('feedback handle links to the hezo_ai X account', async () => {
	seedVersion({ current: '0.2.0' });
	const { findByTestId } = await renderApp({ initialPath: '/settings' });

	const section = await findByTestId('settings-version');
	expect(section.textContent).toContain('Got feedback? @hezo_ai');

	const feedbackLink = section.querySelector(
		'a[href="https://x.com/hezo_ai"]',
	) as HTMLAnchorElement | null;
	expect(feedbackLink).toBeTruthy();
	expect(feedbackLink?.textContent).toContain('@hezo_ai');
});

// ---- staged-update lifecycle rendered in place (mirrors the top-of-shell banner) ----

const AVAILABLE: UpdateStatusInfo = {
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

/**
 * Render just the Version section against a fresh query client so we can drive the
 * staged-update lifecycle (state + canApply + superuser) deterministically without
 * the real backend. No router needed — the component only reads instance-level hooks.
 */
function renderVersion(status: Partial<UpdateStatusInfo> = {}, isSuperuser = true) {
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
	});
	qc.setQueryData(queryKeys.updateStatus(), { ...AVAILABLE, ...status });
	qc.setQueryData(queryKeys.me(), { type: 'admin', is_superuser: isSuperuser });
	return render(
		<QueryClientProvider client={qc}>
			<VersionDisplay />
		</QueryClientProvider>,
	);
}

afterEach(() => {
	vi.restoreAllMocks();
});

test('an available update on a self-applying instance shows "Downloading new version…" while staging', () => {
	for (const state of [UpdateState.Idle, UpdateState.Checking, UpdateState.Downloading] as const) {
		const { getByTestId, queryByTestId, unmount } = renderVersion({ state });
		expect(getByTestId('settings-version-downloading').textContent).toContain(
			'Downloading new version',
		);
		expect(queryByTestId('settings-version-install')).toBeNull();
		unmount();
	}
});

test('a staged update on a self-applying instance shows an "Install & restart" button', () => {
	const { getByTestId } = renderVersion({ state: UpdateState.Staged });
	expect(getByTestId('settings-version-install').textContent).toContain('Install & restart');
	expect(getByTestId('settings-version-result').textContent).toContain('0.2.0');
});

test('Install & restart asks for confirmation (with master-key warning) then applies', async () => {
	const user = userEvent.setup();
	const postSpy = vi
		.spyOn(api, 'post')
		.mockResolvedValue({ state: UpdateState.Applying, targetVersion: '0.2.0' });
	const { getByTestId, findByTestId, queryByTestId } = renderVersion({ state: UpdateState.Staged });

	await user.click(getByTestId('settings-version-install'));
	const dialog = await findByTestId('confirm-dialog');
	expect(dialog.textContent).toContain('master key');
	expect(postSpy).not.toHaveBeenCalled();
	expect(queryByTestId('update-restart-overlay')).toBeNull();

	await user.click(getByTestId('confirm-dialog-confirm'));
	expect(await findByTestId('update-restart-overlay')).toBeTruthy();
	expect(postSpy).toHaveBeenCalledWith('/api/updates/apply');
});

test('a staging error offers a retry (with a manual download link)', async () => {
	const user = userEvent.setup();
	const postSpy = vi
		.spyOn(api, 'post')
		.mockResolvedValue({ data: { state: UpdateState.Downloading, targetVersion: '0.2.0' } });
	vi.spyOn(api, 'get').mockResolvedValue({ ...AVAILABLE, state: UpdateState.Downloading });
	const { getByTestId } = renderVersion({ state: UpdateState.Error });

	expect(getByTestId('settings-version-retry').textContent).toContain('Retry download');
	const link = getByTestId('settings-version-download') as HTMLAnchorElement;
	expect(link.getAttribute('href')).toBe('https://github.com/hezo-ai/hezo/releases/0.2.0');

	await user.click(getByTestId('settings-version-retry'));
	expect(postSpy).toHaveBeenCalledWith('/api/updates/download');
});

test('an instance that cannot self-apply falls back to a release download link', () => {
	const { getByTestId, queryByTestId } = renderVersion({ canApply: false });
	expect(queryByTestId('settings-version-install')).toBeNull();
	expect(queryByTestId('settings-version-downloading')).toBeNull();
	const link = getByTestId('settings-version-download') as HTMLAnchorElement;
	expect(link.textContent).toContain('Download');
	expect(link.getAttribute('href')).toBe('https://github.com/hezo-ai/hezo/releases/0.2.0');
});

test('a superuser-less caller on a self-applying instance still cannot apply (download link)', () => {
	const { getByTestId, queryByTestId } = renderVersion({ state: UpdateState.Staged }, false);
	expect(queryByTestId('settings-version-install')).toBeNull();
	expect(getByTestId('settings-version-download')).toBeTruthy();
});

test('advances from "Downloading new version…" to "Install & restart" via polling — no reload', async () => {
	// Reproduces the reported bug: the server hands back the initial `idle` snapshot first
	// (the background stage hasn't written `downloading` to disk yet), then `staged` once
	// the download lands. The section must follow that transition live via its `poll: true`
	// refetch instead of stranding the spinner until the user manually refreshes.
	vi.spyOn(api, 'get')
		.mockResolvedValueOnce({ ...AVAILABLE, state: UpdateState.Idle })
		.mockResolvedValue({ ...AVAILABLE, state: UpdateState.Staged });
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
	qc.setQueryData(queryKeys.me(), { type: 'admin', is_superuser: true });
	const { findByTestId, queryByTestId } = render(
		<QueryClientProvider client={qc}>
			<VersionDisplay />
		</QueryClientProvider>,
	);

	// Initial status fetch resolves to `idle` → the download spinner, no install button yet.
	expect((await findByTestId('settings-version-downloading')).textContent).toContain(
		'Downloading new version',
	);
	expect(queryByTestId('settings-version-install')).toBeNull();

	// The interval poll (~2.5s) observes `staged` and the section flips in place, no reload.
	const install = await findByTestId('settings-version-install', undefined, { timeout: 5000 });
	expect(install.textContent).toContain('Install & restart');
	expect(queryByTestId('settings-version-downloading')).toBeNull();
});
