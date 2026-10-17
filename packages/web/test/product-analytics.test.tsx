import {
	resetRuntimeConfig,
	runtimeConfig,
	setPolicy,
	setRuntimeConfig,
} from '@hezo/server/src/config/runtime';
import type { SsoConfig, UmamiAnalyticsConfig } from '@hezo/server/src/config/types';
import { queryClient } from '@hezo/web/lib/query-client';
import { queryKeys } from '@hezo/web/lib/query-keys';
import { afterEach, expect, test, vi } from 'vitest';
import { renderApp } from './helpers/render';
import { seedWorkspace } from './helpers/seed';

// Analytics load only for the owner of an instance whose deployer configured
// them. The server here is real, so who counts as the owner is decided by the
// route, not by anything this file fakes. What is faked is the tracker itself,
// which never loads in happy-dom: the blocked load is reported as a success,
// and a stand-in defines the runtime API the real one would.
//
// The loader installs once per page, and this file is one page, so the spec
// that installs it runs last.

const SSO: SsoConfig = {
	issuerUrl: 'https://control.example',
	logoutUrl: 'https://control.example/logout',
	issuerPublicKey: `k1:${'a'.repeat(64)}`,
	ownerSubject: '9f1cb2d4-0000-4000-8000-000000000001',
	audience: 'alice.control.example',
};

const UMAMI: UmamiAnalyticsConfig = {
	host: 'https://stats.example/hz',
	websiteId: '2d1f3c4b-5a69-4f7e-8d9c-0b1a2c3d4e5f',
	distinctId: 'account-1',
	scriptIntegrity: `sha384-${'A'.repeat(64)}`,
	recorderIntegrity: `sha384-${'B'.repeat(64)} sha384-${'C'.repeat(64)}`,
	replay: { sampleRate: 1, showText: false },
};

type Payload = Record<string, unknown>;

interface TestWindow {
	umami?: { track: ReturnType<typeof vi.fn> };
	happyDOM: { settings: { handleDisabledFileLoadingAsSuccess: boolean } };
	[hook: string]: unknown;
}

const testWindow = window as unknown as TestWindow;

function configure(options: { issuer: boolean; umami?: UmamiAnalyticsConfig }): void {
	setRuntimeConfig({ ...runtimeConfig(), sso: options.issuer ? SSO : null });
	setPolicy({
		managedBy: 'Acme Cloud',
		pinned: {},
		...(options.umami ? { analytics: { umami: options.umami } } : {}),
	});
}

function tracker(): HTMLScriptElement | null {
	return document.head.querySelector(`script[src="${UMAMI.host}/script.js"]`);
}

function recorder(): HTMLScriptElement | null {
	return document.head.querySelector(`script[src="${UMAMI.host}/recorder.js"]`);
}

/** How often the analytics settings are asked for again, as the query now stands. */
function recheckInterval(): unknown {
	const query = queryClient.getQueryCache().find({ queryKey: queryKeys.analytics() });
	const interval: unknown = query?.observers[0]?.options.refetchInterval;
	return typeof interval === 'function' ? interval(query) : interval;
}

/** What the tracker would send for a payload, after the page's before-send hook. */
function sent(payload: Payload): Payload | false {
	const name = tracker()?.getAttribute('data-before-send') ?? '';
	const hook = testWindow[name] as (type: string, payload: Payload) => Payload | false;
	return hook('event', payload);
}

afterEach(() => {
	resetRuntimeConfig();
	testWindow.happyDOM.settings.handleDisabledFileLoadingAsSuccess = false;
	tracker()?.remove();
	recorder()?.remove();
	document.documentElement.classList.remove('rr-mask', 'rr-block');
	sessionStorage.clear();
	delete testWindow.umami;
});

test('an instance with no issuer never asks, and loads nothing', async () => {
	const { findByTestId } = await renderApp({
		initialPath: '/home',
		seed: () => configure({ issuer: false, umami: UMAMI }),
	});

	await findByTestId('app-header-settings');
	expect(queryClient.getQueryState(queryKeys.analytics())?.dataUpdatedAt ?? 0).toBe(0);
	expect(queryClient.getQueryState(queryKeys.analytics())?.fetchStatus ?? 'idle').toBe('idle');
	expect(tracker()).toBeNull();
	expect(recorder()).toBeNull();
	expect(document.documentElement.classList.contains('rr-mask')).toBe(false);
});

test('an issuer with no analytics configured loads nothing', async () => {
	const { findByTestId } = await renderApp({
		initialPath: '/home',
		seed: () => configure({ issuer: true }),
	});

	await findByTestId('app-header-settings');
	await expect.poll(() => queryClient.getQueryState(queryKeys.analytics())?.status).toBe('error');
	expect(tracker()).toBeNull();
	expect(recorder()).toBeNull();
});

test('the owner is counted by route pattern, page by page, and recorded with page text hidden', async () => {
	testWindow.happyDOM.settings.handleDisabledFileLoadingAsSuccess = true;
	const track = vi.fn();
	testWindow.umami = { track };
	const pageViews = () => track.mock.calls.filter(([event]) => typeof event !== 'string').length;
	let hq = '';

	const { findByTestId, router, user } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			configure({ issuer: true, umami: UMAMI });
			hq = (await seedWorkspace()).internalSlug;
		},
	});

	await expect.poll(tracker).not.toBeNull();
	const script = tracker() as HTMLScriptElement;
	expect(script.getAttribute('data-website-id')).toBe(UMAMI.websiteId);
	expect(script.getAttribute('data-distinct-id')).toBe(UMAMI.distinctId);
	expect(script.getAttribute('data-auto-track')).toBe('false');
	// Both scripts are pinned to the hashes the deployer wrote into the policy.
	expect(script.getAttribute('integrity')).toBe(UMAMI.scriptIntegrity);
	expect(script.getAttribute('crossorigin')).toBe('anonymous');
	expect(recorder()?.getAttribute('integrity')).toBe(UMAMI.recorderIntegrity);
	expect(recorder()?.getAttribute('crossorigin')).toBe('anonymous');

	// Every visit is recorded at a rate of 1, with the page's text hidden first.
	expect(recorder()?.getAttribute('data-website-id')).toBe(UMAMI.websiteId);
	expect(document.documentElement.classList.contains('rr-mask')).toBe(true);

	// The page the visit starts on, sent under its pattern rather than its address.
	await expect.poll(pageViews).toBe(1);
	expect(track.mock.calls[0]).toEqual([]);
	expect(
		sent({ url: `${window.location.origin}/home?tab=x#y`, title: 'Home', referrer: '/settings' }),
	).toMatchObject({ url: '/home', title: '/home', referrer: '' });

	// A route change is one page view, sent under the new route's pattern and
	// never under the project it is about.
	await router.navigate({ to: '/projects/$projectId/tasks', params: { projectId: hq } });
	await expect.poll(pageViews).toBe(2);
	expect(sent({ url: `/projects/${hq}/tasks`, title: hq })).toMatchObject({
		url: '/projects/$projectId/tasks',
		title: '/projects/$projectId/tasks',
	});

	// Back is a page view too, which the tracker alone never sees.
	router.history.back();
	await expect.poll(pageViews).toBe(3);
	expect(sent({ url: 'anything' })).toMatchObject({ url: '/home' });

	// A named control is counted by its name, never by its text, and the
	// navigation it starts is a page view of its own.
	await user.click(await findByTestId('app-header-settings'));
	await expect
		.poll(() => track.mock.calls.filter(([event]) => event === 'open-settings'))
		.toHaveLength(1);
	await expect.poll(pageViews).toBe(4);
	expect(sent({ url: 'anything' })).toMatchObject({ url: '/settings' });

	// A change of query alone is the same page.
	await router.navigate({ to: '/settings/credentials', search: { focus: 'A_TOKEN' } });
	await expect.poll(pageViews).toBe(5);
	await router.navigate({ to: '/settings/credentials', search: { focus: 'B_TOKEN' } });
	await expect.poll(() => router.state.location.search).toMatchObject({ focus: 'B_TOKEN' });
	expect(pageViews()).toBe(5);
	expect(sent({ url: 'anything' })).toMatchObject({ url: '/settings/credentials' });

	// A recorded page asks again while it records, so a stop the deployer makes
	// while the owner keeps the app open reaches the recording already running:
	// the rest of the page is left out of it, and the asking stops.
	expect(recheckInterval()).toBe(2 * 60_000);
	const { replay: _replay, ...unrecorded } = UMAMI;
	configure({ issuer: true, umami: unrecorded });
	await queryClient.refetchQueries({ queryKey: queryKeys.analytics() });
	await expect.poll(() => document.documentElement.classList.contains('rr-block')).toBe(true);
	expect(recheckInterval()).toBe(false);
});
