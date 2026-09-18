import {
	resetRuntimeConfig,
	runtimeConfig,
	setPolicy,
	setRuntimeConfig,
} from '@hezo/server/src/config/runtime';
import type { ChatwootSupportConfig, SsoConfig } from '@hezo/server/src/config/types';
import { api } from '@hezo/web/lib/api';
import * as sso from '@hezo/web/lib/sso';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { renderApp } from './helpers/render';

// The screens before a session are where somebody shut out of their own
// instance waits, and the chat has to be there. It loads naming nobody: this
// page has no account to be, and an identity would let whoever reached it write
// to the support team as the owner.
//
// **Its own file** because the loader installs once per page and keeps that
// state for the life of the module. A spec that installs an identified widget
// would leave nothing for this one to observe, and the two cannot share a page.

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
	toggleBubbleVisibility: ReturnType<typeof vi.fn>;
	reset: ReturnType<typeof vi.fn>;
}

interface TestWindow {
	chatwootSDK?: { run: () => void };
	$chatwoot?: FakeChatwoot;
	happyDOM: { settings: { handleDisabledFileLoadingAsSuccess: boolean } };
}

const testWindow = window as unknown as TestWindow;

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

test('a screen reached before signing in loads the widget, naming nobody', async () => {
	testWindow.happyDOM.settings.handleDisabledFileLoadingAsSuccess = true;
	const chatwoot: FakeChatwoot = {
		setUser: vi.fn(),
		toggle: vi.fn(),
		setLocale: vi.fn(),
		setColorScheme: vi.fn(),
		toggleBubbleVisibility: vi.fn(),
		reset: vi.fn(),
	};
	testWindow.chatwootSDK = {
		run: () => {
			testWindow.$chatwoot = chatwoot;
		},
	};

	await renderApp({
		initialPath: '/login',
		seed: () => {
			setRuntimeConfig({ ...runtimeConfig(), sso: SSO });
			setPolicy({
				managedBy: 'Acme Cloud',
				manageUrl: 'https://control.example/plan',
				pinned: {},
				support: { chatwoot: CHATWOOT },
			});
			// The harness signs a session in for every render. Drop it, because the
			// screen under test is the one reached without one.
			localStorage.removeItem('hezo_token');
			api.clearToken();
		},
	});

	// The channel rides on the public status, which needs no session to read.
	await expect.poll(() => widgetScript()?.getAttribute('integrity')).toBe('sha384-abc');
	await expect.poll(() => testWindow.$chatwoot).toBe(chatwoot);
	window.dispatchEvent(new Event('chatwoot:ready'));

	expect(chatwoot.setUser).not.toHaveBeenCalled();
	// And the launcher is there to be clicked: nothing on these screens claims
	// the corner the shell's chat dock later takes.
	expect(chatwoot.toggleBubbleVisibility).toHaveBeenLastCalledWith('show');
});
