import {
	resetRuntimeConfig,
	runtimeConfig,
	setPolicy,
	setRuntimeConfig,
} from '@hezo/server/src/config/runtime';
import type { ChatwootSupportConfig, SsoConfig } from '@hezo/server/src/config/types';
import { createTestProject, createTestTeam } from '@hezo/server/test/helpers/app';
import * as sso from '@hezo/web/lib/sso';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';

// What the open chat tells the support team about where the owner is. The
// widget's own script never loads in happy-dom: the blocked load is reported as
// a success, and a stand-in SDK defines the runtime API the real one would.
//
// **Its own file, and one spec**, because the loader installs once per page and
// keeps its state for the life of the module. A second spec here would start
// from a chat the first one had already loaded, readied and opened.

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
	setCustomAttributes: ReturnType<typeof vi.fn>;
	reset: ReturnType<typeof vi.fn>;
}

interface TestWindow {
	chatwootSDK?: { run: () => void };
	$chatwoot?: FakeChatwoot;
	happyDOM: {
		settings: { handleDisabledFileLoadingAsSuccess: boolean };
		setViewport(viewport: { width: number }): void;
	};
}

const testWindow = window as unknown as TestWindow;

beforeEach(() => {
	vi.spyOn(sso, 'goToIssuer').mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	resetRuntimeConfig();
	testWindow.happyDOM.settings.handleDisabledFileLoadingAsSuccess = false;
	document.head.querySelector('script[src$="/packs/js/sdk.js"]')?.remove();
	delete testWindow.chatwootSDK;
	delete testWindow.$chatwoot;
});

test('the open chat names the screen and the project, never the path, and follows a resize', async () => {
	testWindow.happyDOM.settings.handleDisabledFileLoadingAsSuccess = true;
	const chatwoot: FakeChatwoot = {
		setUser: vi.fn(),
		toggle: vi.fn(),
		setLocale: vi.fn(),
		setColorScheme: vi.fn(),
		toggleBubbleVisibility: vi.fn(),
		setCustomAttributes: vi.fn(),
		reset: vi.fn(),
	};
	testWindow.chatwootSDK = {
		run: () => {
			testWindow.$chatwoot = chatwoot;
		},
	};
	const lastSent = () => chatwoot.setCustomAttributes.mock.lastCall?.[0];

	let slug = '';
	const { findByTestId, router } = await renderApp({
		initialPath: '/settings',
		seed: async () => {
			setRuntimeConfig({ ...runtimeConfig(), sso: SSO });
			setPolicy({
				managedBy: 'Acme Cloud',
				manageUrl: 'https://control.example/plan',
				pinned: {},
				support: { chatwoot: CHATWOOT },
			});
			const { db } = getTestContext();
			const team = (await (await createTestTeam(db, { name: 'Demo Team' })).json()).data;
			slug = (await (await createTestProject(db, team.id, { name: 'Storefront' })).json()).data
				.slug;
		},
	});
	await findByTestId('settings-nav-desktop');
	await router.navigate({ to: '/projects/$projectId/documents', params: { projectId: slug } });

	await expect.poll(() => testWindow.$chatwoot).toBe(chatwoot);
	window.dispatchEvent(new Event('chatwoot:ready'));
	window.dispatchEvent(new Event('chatwoot:opened'));
	await expect.poll(() => lastSent()?.hezo_screen).toBe('/projects/$projectId/documents');

	expect(lastSent()).toMatchObject({
		hezo_surface: 'instance',
		hezo_page: '',
		hezo_project: slug,
		hezo_language: 'en',
		hezo_viewport: 'desktop',
		// One person is one contact on every Hezo page, so what a hosting
		// dashboard or website said is cleared rather than left standing.
		hezo_visit: '',
		hezo_instance_status: '',
		hezo_instance_job: '',
		hezo_instance_error: '',
	});
	expect(lastSent()?.hezo_version).toMatch(/^\d+\.\d+\.\d+/);
	expect(JSON.stringify(lastSent())).not.toContain(`/projects/${slug}`);

	// Turning a tablet or resizing a window changes nothing else on the page, so
	// nothing else would make the shell say it again.
	const width = window.innerWidth;
	try {
		testWindow.happyDOM.setViewport({ width: 800 });
		await expect.poll(() => lastSent()?.hezo_viewport).toBe('tablet');
		expect(lastSent()).toMatchObject({ hezo_screen: '/projects/$projectId/documents' });
	} finally {
		testWindow.happyDOM.setViewport({ width });
	}
});
