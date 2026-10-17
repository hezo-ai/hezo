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

// A tab left open until its token expires: nothing else asks the server who is
// signed in, so the analytics recheck is the first to hear the 401, and the
// page has to stop on it. A file of its own, because the analytics loader
// installs once per page and a page turned off stays off for its life.

afterEach(resetAnalyticsPage);

test('a recheck answered 401 stops counting and recording, and stops asking', async () => {
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
	expect(recheckInterval()).toBe(2 * 60_000);

	api.clearToken();
	await queryClient.refetchQueries({ queryKey: queryKeys.analytics() });

	// The session check still holds the owner, so the stop came from the recheck.
	expect(queryClient.getQueryState(queryKeys.me())?.error).toBeNull();
	await expect.poll(recorderCanSend).toBe(false);
	const name = tracker()?.getAttribute('data-before-send') ?? '';
	const hook = testWindow[name] as (type: string, payload: object) => unknown;
	expect(hook('event', { url: 'x' })).toBe(false);
	expect(recheckInterval()).toBe(false);
});
