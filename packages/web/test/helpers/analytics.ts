import {
	resetRuntimeConfig,
	runtimeConfig,
	setPolicy,
	setRuntimeConfig,
} from '@hezo/server/src/config/runtime';
import type { SsoConfig, UmamiAnalyticsConfig } from '@hezo/server/src/config/types';
import { queryClient } from '@hezo/web/lib/query-client';
import { queryKeys } from '@hezo/web/lib/query-keys';
import type { vi } from 'vitest';

// What the product-analytics specs share. The analytics loader installs once
// per page and every spec file is one page, so a spec that needs a fresh page
// lives in a file of its own and draws its setup from here.

export const SSO: SsoConfig = {
	issuerUrl: 'https://control.example',
	logoutUrl: 'https://control.example/logout',
	issuerPublicKey: `k1:${'a'.repeat(64)}`,
	ownerSubject: '9f1cb2d4-0000-4000-8000-000000000001',
	audience: 'alice.control.example',
};

export const UMAMI: UmamiAnalyticsConfig = {
	host: 'https://stats.example/hz',
	websiteId: '2d1f3c4b-5a69-4f7e-8d9c-0b1a2c3d4e5f',
	distinctId: 'account-1',
	scriptIntegrity: `sha384-${'A'.repeat(64)}`,
	recorderIntegrity: `sha384-${'B'.repeat(64)} sha384-${'C'.repeat(64)}`,
	replay: { sampleRate: 1, showText: false },
};

export interface TestWindow {
	umami?: { track: ReturnType<typeof vi.fn> };
	happyDOM: { settings: { handleDisabledFileLoadingAsSuccess: boolean } };
	[hook: string]: unknown;
}

export const testWindow = window as unknown as TestWindow;

export function configure(options: { issuer: boolean; umami?: UmamiAnalyticsConfig }): void {
	setRuntimeConfig({ ...runtimeConfig(), sso: options.issuer ? SSO : null });
	setPolicy({
		managedBy: 'Acme Cloud',
		pinned: {},
		...(options.umami ? { analytics: { umami: options.umami } } : {}),
	});
}

export function tracker(): HTMLScriptElement | null {
	return document.head.querySelector(`script[src="${UMAMI.host}/script.js"]`);
}

export function recorder(): HTMLScriptElement | null {
	return document.head.querySelector(`script[src="${UMAMI.host}/recorder.js"]`);
}

/** How often the analytics settings are asked for again, as the query now stands. */
export function recheckInterval(): unknown {
	const query = queryClient.getQueryCache().find({ queryKey: queryKeys.analytics() });
	const interval: unknown = query?.observers[0]?.options.refetchInterval;
	return typeof interval === 'function' ? interval(query) : interval;
}

/** Undo what a spec did to the page and the instance's configuration. */
export function resetAnalyticsPage(): void {
	resetRuntimeConfig();
	testWindow.happyDOM.settings.handleDisabledFileLoadingAsSuccess = false;
	tracker()?.remove();
	recorder()?.remove();
	document.documentElement.classList.remove('rr-mask', 'rr-block');
	sessionStorage.clear();
	delete testWindow.umami;
}
