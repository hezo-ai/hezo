import {
	resetRuntimeConfig,
	runtimeConfig,
	setPolicy,
	setRuntimeConfig,
} from '@hezo/server/src/config/runtime';
import type { ChatwootSupportConfig, SsoConfig } from '@hezo/server/src/config/types';
import { queryClient } from '@hezo/web/lib/query-client';
import { queryKeys } from '@hezo/web/lib/query-keys';
import * as sso from '@hezo/web/lib/sso';
import { within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { renderApp } from './helpers/render';

// The support row and the widget behind it exist only for the instance owner
// on a deployment that configured a channel. The server here is real, so who
// counts as the owner is decided by the route, not by anything this file fakes.
// What is faked is the widget's own script, which never loads in happy-dom:
// the blocked load is reported as a success, and a stand-in SDK defines the
// runtime API the real one would.

const SSO: SsoConfig = {
	issuerUrl: 'https://control.example',
	logoutUrl: 'https://control.example/logout',
	issuerPublicKey: `k1:${'a'.repeat(64)}`,
	ownerSubject: '9f1cb2d4-0000-4000-8000-000000000001',
	audience: 'alice.control.example',
};

const CHATWOOT: ChatwootSupportConfig = {
	baseUrl: 'https://chat.example',
	websiteToken: 'website-token',
	sdkIntegrity: 'sha384-abc',
	identifier: 'contact-1',
	identifierHash: 'f'.repeat(64),
	name: 'alice',
	email: 'alice@example.com',
};

interface FakeChatwoot {
	setUser: ReturnType<typeof vi.fn>;
	toggle: ReturnType<typeof vi.fn>;
	setLocale: ReturnType<typeof vi.fn>;
	setColorScheme: ReturnType<typeof vi.fn>;
	reset: ReturnType<typeof vi.fn>;
}

interface TestWindow {
	chatwootSDK?: { run: () => void };
	$chatwoot?: FakeChatwoot;
	happyDOM: { settings: { handleDisabledFileLoadingAsSuccess: boolean } };
}

const testWindow = window as unknown as TestWindow;

function configure(options: { issuer: boolean; chatwoot?: ChatwootSupportConfig }): void {
	setRuntimeConfig({ ...runtimeConfig(), sso: options.issuer ? SSO : null });
	setPolicy({
		managedBy: 'Acme Cloud',
		manageUrl: 'https://control.example/plan',
		pinned: {},
		...(options.chatwoot ? { support: { chatwoot: options.chatwoot } } : {}),
	});
}

function widgetScript(): HTMLScriptElement | null {
	return document.head.querySelector('script[src$="/packs/js/sdk.js"]');
}

beforeEach(() => {
	vi.spyOn(sso, 'goToIssuer').mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	resetRuntimeConfig();
	testWindow.happyDOM.settings.handleDisabledFileLoadingAsSuccess = false;
	widgetScript()?.remove();
	delete testWindow.chatwootSDK;
	delete testWindow.$chatwoot;
});

test('an instance with no issuer shows no support row and loads no widget', async () => {
	const { findAllByTestId, queryAllByTestId } = await renderApp({
		initialPath: '/settings',
		seed: () => configure({ issuer: false, chatwoot: CHATWOOT }),
	});

	// The deployer's group is on screen, so the settings behind it have loaded.
	await findAllByTestId('settings-policy-link');
	expect(queryAllByTestId('settings-contact-support')).toHaveLength(0);
	expect(widgetScript()).toBeNull();
});

test('an issuer with no support channel shows no support row and loads no widget', async () => {
	const { findAllByTestId, queryAllByTestId } = await renderApp({
		initialPath: '/settings',
		seed: () => configure({ issuer: true }),
	});

	await findAllByTestId('settings-policy-link');
	await expect.poll(() => queryClient.getQueryState(queryKeys.support())?.status).toBe('error');
	expect(queryAllByTestId('settings-contact-support')).toHaveLength(0);
	expect(widgetScript()).toBeNull();
});

test('the owner gets the row, an identified widget, and a reset on sign-out', async () => {
	testWindow.happyDOM.settings.handleDisabledFileLoadingAsSuccess = true;
	const chatwoot: FakeChatwoot = {
		setUser: vi.fn(),
		toggle: vi.fn(),
		setLocale: vi.fn(),
		setColorScheme: vi.fn(),
		reset: vi.fn(),
	};
	testWindow.chatwootSDK = {
		run: () => {
			testWindow.$chatwoot = chatwoot;
		},
	};

	const { findByTestId, user } = await renderApp({
		initialPath: '/settings',
		seed: () => configure({ issuer: true, chatwoot: CHATWOOT }),
	});

	const desktopNav = await findByTestId('settings-nav-desktop');
	const row = await within(desktopNav).findByTestId('settings-contact-support');
	expect(row.textContent).toContain('Contact support');

	expect(widgetScript()?.getAttribute('integrity')).toBe('sha384-abc');
	await expect.poll(() => testWindow.$chatwoot).toBe(chatwoot);
	window.dispatchEvent(new Event('chatwoot:ready'));
	expect(chatwoot.setUser).toHaveBeenCalledWith('contact-1', {
		name: 'alice',
		email: 'alice@example.com',
		identifier_hash: 'f'.repeat(64),
	});

	await user.click(row);
	expect(chatwoot.toggle).toHaveBeenCalledWith('open');

	await user.click(within(desktopNav).getByTestId('settings-logout'));
	expect(chatwoot.reset).toHaveBeenCalledTimes(1);
	await expect.poll(() => vi.mocked(sso.goToIssuer).mock.calls[0]?.[0]).toBe(SSO.logoutUrl);
});
