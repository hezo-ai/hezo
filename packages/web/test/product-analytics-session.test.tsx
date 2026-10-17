import { api } from '@hezo/web/lib/api';
import { queryClient } from '@hezo/web/lib/query-client';
import { queryKeys } from '@hezo/web/lib/query-keys';
import { afterEach, expect, test, vi } from 'vitest';
import {
	configure,
	recheckInterval,
	recorderCanSend,
	resetAnalyticsPage,
	standInTracker,
	testWindow,
	tracker,
	UMAMI,
} from './helpers/analytics';
import { renderApp } from './helpers/render';
import { seedWorkspace } from './helpers/seed';

// A page that loses its owner while it stays open: the session ends, the
// server answers 401 to the next session check, and nothing more is counted or
// recorded on the page. A file of its own, because the analytics loader
// installs once per page and a page turned off stays off for its life.

afterEach(resetAnalyticsPage);

test('a session that ends while the page is open stops counting and recording', async () => {
	testWindow.happyDOM.settings.handleDisabledFileLoadingAsSuccess = true;
	const track = vi.fn();
	testWindow.umami = standInTracker(track);

	await renderApp({
		initialPath: '/home',
		seed: async () => {
			configure({ issuer: true, umami: UMAMI });
			await seedWorkspace();
		},
	});

	await expect.poll(tracker).not.toBeNull();
	await expect.poll(() => track.mock.calls.length).toBeGreaterThan(0);
	expect(document.documentElement.classList.contains('rr-mask')).toBe(true);
	expect(recheckInterval()).toBe(2 * 60_000);

	api.clearToken();
	await queryClient.refetchQueries({ queryKey: queryKeys.me() });

	await expect.poll(recorderCanSend).toBe(false);
	const name = tracker()?.getAttribute('data-before-send') ?? '';
	const hook = testWindow[name] as (type: string, payload: object) => unknown;
	expect(hook('event', { url: 'x' })).toBe(false);
});
