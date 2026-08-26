import {
	resetRuntimeConfig,
	runtimeConfig,
	setRuntimeConfig,
} from '@hezo/server/src/config/runtime';
import type { SsoConfig } from '@hezo/server/src/config/types';
import {
	buildSsoTokenMessage,
	deriveAuthKeyPair,
	encodeSsoToken,
	generateMnemonic,
	type SsoTokenPayload,
	signAuthMessage,
} from '@hezo/shared';
import { api } from '@hezo/web/lib/api';
import * as sso from '@hezo/web/lib/sso';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { renderApp } from './helpers/render';

/**
 * Where the browser was sent, if it was. Spied rather than performed: a real
 * navigation would tear the test environment's document out from under the
 * assertions, and the destination is the thing worth checking anyway.
 */
let destination: string | null = null;
function leftFor(): string | null {
	return destination;
}

beforeEach(() => {
	destination = null;
	vi.spyOn(sso, 'goToIssuer').mockImplementation((url: string) => {
		destination = url;
	});
});

// Signing in happens at the issuer, so an instance carrying one has no sign-in
// of its own: an unidentified visitor is handed back, and returns with a token.
// The server app is real here, so the token is minted and verified for real too.

const ISSUER = deriveAuthKeyPair(generateMnemonic());
const OWNER = '9f1cb2d4-0000-4000-8000-000000000001';
const AUDIENCE = 'alice.control.example';

const SSO: SsoConfig = {
	issuerUrl: 'https://control.example',
	issuerPublicKey: `k1:${ISSUER.publicKeyHex}`,
	ownerSubject: OWNER,
	audience: AUDIENCE,
};

let jti = 0;

function mintToken(overrides: Partial<SsoTokenPayload> = {}): string {
	const iat = Math.floor(Date.now() / 1000);
	const payload: SsoTokenPayload = {
		kid: 'k1',
		aud: AUDIENCE,
		sub: OWNER,
		jti: `web-${jti++}`,
		iat,
		exp: iat + 60,
		...overrides,
	};
	return encodeSsoToken(payload, signAuthMessage(ISSUER.privateKey, buildSsoTokenMessage(payload)));
}

/** Configure an issuer on the live server the harness is serving. */
function configureIssuer(sso: SsoConfig | null): void {
	setRuntimeConfig({ ...runtimeConfig(), sso });
}

function signedOut(): void {
	api.clearToken();
	localStorage.removeItem('hezo_token');
}

afterEach(() => {
	vi.restoreAllMocks();
	resetRuntimeConfig();
	window.location.hash = '';
});

test('hands an unidentified visitor to the issuer', async () => {
	const { findByTestId } = await renderApp({
		initialPath: '/',
		seed: () => {
			signedOut();
			configureIssuer(SSO);
		},
	});

	// Named by host, and by the URL the browser is actually sent to - the two
	// cannot disagree.
	const gate = await findByTestId('sso-redirect');
	expect(gate.textContent).toContain('control.example');
	await expect.poll(() => leftFor()).toBe('https://control.example');
});

// The whole point of the flag being a presence check: an instance without an
// issuer is untouched.
test('shows the ordinary password login when no issuer is configured', async () => {
	const { findByTestId, queryByTestId } = await renderApp({
		initialPath: '/',
		seed: () => {
			signedOut();
			configureIssuer(null);
		},
	});

	await findByTestId('password-login');
	expect(queryByTestId('sso-redirect')).toBeNull();
	expect(leftFor()).toBeNull();
});

// There is deliberately no second door: an instance signed in through an issuer
// never enrolls a password, and offering one would defeat the point of the first.
test('offers no password fallback, even where a password exists', async () => {
	const { findByTestId, queryByTestId } = await renderApp({
		initialPath: '/',
		seed: () => {
			signedOut();
			configureIssuer(SSO);
		},
	});

	const gate = await findByTestId('sso-redirect');
	expect(queryByTestId('password-login')).toBeNull();
	expect(gate.textContent?.toLowerCase()).not.toContain('password');
});

test('signs in from a token in the fragment, and strips it from the address bar', async () => {
	const token = mintToken();
	const { queryByTestId } = await renderApp({
		initialPath: '/',
		seed: () => {
			signedOut();
			configureIssuer(SSO);
			window.location.hash = `#sso=${token}`;
		},
	});

	// Waits on the session appearing, not on a screen disappearing: absence is
	// true the instant the exchange starts, so polling for it would pass before
	// anything had happened.
	await expect.poll(() => api.getToken()).toBeTruthy();
	expect(queryByTestId('sso-redirect')).toBeNull();
	expect(queryByTestId('password-login')).toBeNull();
	// A copied URL or a back-navigation must not carry the token.
	expect(window.location.hash).toBe('');
});

// Bouncing straight back to the issuer after a rejected token is a loop: it
// would mint another and send the visitor round again.
test('stops rather than redirecting again when the token is rejected', async () => {
	const { findByTestId, findByText } = await renderApp({
		initialPath: '/',
		seed: () => {
			signedOut();
			configureIssuer(SSO);
			window.location.hash = `#sso=${mintToken({ sub: 'somebody-else' })}`;
		},
	});

	await findByTestId('sso-redirect');
	await findByText(/Sign-in token rejected/);
	expect(api.getToken()).toBeNull();
	expect(leftFor()).toBeNull();
});
