import {
	buildLoginMessage,
	buildPasswordLoginMessage,
	buildSetupMessage,
	buildUnlockMessage,
	deriveAuthKeyPair,
	derivePasswordKeyPair,
	deriveUnlockKey,
	generateMnemonic,
	generatePasswordSalt,
	verifyAuthSignature,
} from '@hezo/shared';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Mock the api client so the auth flows can be exercised without a server. Each
// method is a vi.fn whose behaviour the individual tests configure.
const post = vi.fn();
const setToken = vi.fn();
const getToken = vi.fn();
const clearToken = vi.fn();
vi.mock('../src/lib/api', () => ({
	api: {
		post: (...a: unknown[]) => post(...a),
		setToken: (...a: unknown[]) => setToken(...a),
		getToken: (...a: unknown[]) => getToken(...a),
		clearToken: (...a: unknown[]) => clearToken(...a),
	},
}));

import {
	authenticateWithMnemonic,
	checkStatus,
	clearPendingSetupToken,
	getPendingSetupToken,
	isAuthenticated,
	loginWithPassword,
	logout,
} from '../src/lib/auth';

const PHRASE = generateMnemonic();

beforeEach(() => {
	post.mockReset();
	setToken.mockReset();
	getToken.mockReset();
	clearToken.mockReset();
	clearPendingSetupToken();
});
afterEach(() => {
	vi.restoreAllMocks();
});

function mockFetchOnce(
	body: unknown,
	init?: { ok?: boolean; status?: number; statusText?: string },
) {
	const ok = init?.ok ?? true;
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => ({
			ok,
			status: init?.status ?? (ok ? 200 : 500),
			statusText: init?.statusText ?? '',
			json: async () => body,
		})),
	);
}

describe('checkStatus', () => {
	test('returns the booting shape when starting is true', async () => {
		mockFetchOnce({
			starting: true,
			phase: 'migrations',
			message: 'Applying',
			detail: 'step 3',
			version: '1.2.3',
		});
		await expect(checkStatus()).resolves.toEqual({
			starting: true,
			phase: 'migrations',
			message: 'Applying',
			detail: 'step 3',
			version: '1.2.3',
		});
	});

	test('returns the full body when masterKeyState is present', async () => {
		mockFetchOnce({ masterKeyState: 'unlocked', version: '1.0.0' });
		await expect(checkStatus()).resolves.toEqual({
			masterKeyState: 'unlocked',
			version: '1.0.0',
		});
	});

	test('throws the server error message on a non-ok response', async () => {
		mockFetchOnce(
			{ error: { code: 'BOOM', message: 'kaboom' } },
			{ ok: false, status: 503, statusText: 'Service Unavailable' },
		);
		await expect(checkStatus()).rejects.toThrow('kaboom');
	});

	test('falls back to statusText, then a synthetic message, on a bare error', async () => {
		mockFetchOnce({}, { ok: false, status: 500, statusText: 'Internal Error' });
		await expect(checkStatus()).rejects.toThrow('Internal Error');
	});

	test('throws a synthesized message when ok is false and statusText is empty', async () => {
		mockFetchOnce({}, { ok: false, status: 502, statusText: '' });
		await expect(checkStatus()).rejects.toThrow('Status request failed (502)');
	});

	test('throws when an ok response has no masterKeyState', async () => {
		mockFetchOnce({ version: '1.0.0' });
		await expect(checkStatus()).rejects.toThrow('Invalid status response from server');
	});
});

describe('authenticateWithMnemonic — setup (unset)', () => {
	test('posts a valid setup payload and holds the scoped token (not a session)', async () => {
		post.mockResolvedValueOnce({ token: 'tok-setup' });
		await authenticateWithMnemonic(PHRASE, 'unset');

		// The mnemonic only unlocks: the token is held in memory for the
		// create-password step, never stored as a session.
		expect(getPendingSetupToken()).toBe('tok-setup');
		expect(setToken).not.toHaveBeenCalled();
		expect(post).toHaveBeenCalledTimes(1);
		const [path, payload] = post.mock.calls[0] as [string, Record<string, string>];
		expect(path).toBe('/api/auth/setup');

		const keys = deriveAuthKeyPair(PHRASE);
		const unlockKey = deriveUnlockKey(PHRASE);
		expect(payload.public_key).toBe(keys.publicKeyHex);
		expect(payload.unlock_key).toBe(unlockKey);
		// The signature must verify against the derived public key and the
		// canonical setup message.
		expect(
			verifyAuthSignature(
				keys.publicKeyHex,
				buildSetupMessage(keys.publicKeyHex, unlockKey),
				payload.signature,
			),
		).toBe(true);
	});
});

describe('authenticateWithMnemonic — login (unlocked)', () => {
	test('runs the challenge dance with a login signature and no unlock key', async () => {
		post
			.mockResolvedValueOnce({ challenge_id: 'c1', nonce: 'abcd' }) // /api/auth/challenge
			.mockResolvedValueOnce({ token: 'tok-login' }); // /api/auth/verify

		await authenticateWithMnemonic(PHRASE, 'unlocked');
		expect(getPendingSetupToken()).toBe('tok-login');
		expect(setToken).not.toHaveBeenCalled();

		expect(post.mock.calls[0][0]).toBe('/api/auth/challenge');
		const [verifyPath, body] = post.mock.calls[1] as [string, Record<string, string>];
		expect(verifyPath).toBe('/api/auth/verify');
		expect(body.challenge_id).toBe('c1');
		expect(body.unlock_key).toBeUndefined();

		const keys = deriveAuthKeyPair(PHRASE);
		expect(verifyAuthSignature(keys.publicKeyHex, buildLoginMessage('abcd'), body.signature)).toBe(
			true,
		);
	});
});

describe('authenticateWithMnemonic — unlock (locked)', () => {
	test('includes the unlock key and signs the unlock message', async () => {
		post
			.mockResolvedValueOnce({ challenge_id: 'c2', nonce: 'beef' })
			.mockResolvedValueOnce({ token: 'tok-unlock' });

		await authenticateWithMnemonic(PHRASE, 'locked');
		expect(getPendingSetupToken()).toBe('tok-unlock');

		const body = post.mock.calls[1][1] as Record<string, string>;
		const unlockKey = deriveUnlockKey(PHRASE);
		expect(body.unlock_key).toBe(unlockKey);

		const keys = deriveAuthKeyPair(PHRASE);
		expect(
			verifyAuthSignature(keys.publicKeyHex, buildUnlockMessage('beef', unlockKey), body.signature),
		).toBe(true);
	});
});

describe('authenticateWithMnemonic — unlock-required retry', () => {
	test('retries with the unlock key when a login attempt is rejected with UNLOCK_KEY_REQUIRED', async () => {
		post
			.mockResolvedValueOnce({ challenge_id: 'c3', nonce: '1111' }) // first challenge
			.mockRejectedValueOnce({ code: 'UNLOCK_KEY_REQUIRED', message: 'locked', status: 409 }) // first verify rejects
			.mockResolvedValueOnce({ challenge_id: 'c4', nonce: '2222' }) // retry challenge
			.mockResolvedValueOnce({ token: 'tok-retry' }); // retry verify

		await authenticateWithMnemonic(PHRASE, 'unlocked');
		expect(getPendingSetupToken()).toBe('tok-retry');

		// Second attempt carries the unlock key + unlock-message signature.
		const retryBody = post.mock.calls[3][1] as Record<string, string>;
		const unlockKey = deriveUnlockKey(PHRASE);
		expect(retryBody.unlock_key).toBe(unlockKey);
		const keys = deriveAuthKeyPair(PHRASE);
		expect(
			verifyAuthSignature(
				keys.publicKeyHex,
				buildUnlockMessage('2222', unlockKey),
				retryBody.signature,
			),
		).toBe(true);
	});

	test('rethrows a non-UNLOCK_KEY_REQUIRED error without retrying', async () => {
		post
			.mockResolvedValueOnce({ challenge_id: 'c5', nonce: '3333' })
			.mockRejectedValueOnce({ code: 'BAD_SIGNATURE', message: 'nope', status: 401 });

		await expect(authenticateWithMnemonic(PHRASE, 'unlocked')).rejects.toMatchObject({
			code: 'BAD_SIGNATURE',
		});
		// challenge + failed verify only; no retry challenge.
		expect(post).toHaveBeenCalledTimes(2);
	});
});

describe('loginWithPassword', () => {
	test('signs the nonce with a password-derived key and stores the session', async () => {
		const salt = generatePasswordSalt();
		post
			.mockResolvedValueOnce({ challenge_id: 'pc1', nonce: 'facef00d', salt }) // password-challenge
			.mockResolvedValueOnce({ token: 'sess-tok' }); // password-verify

		await loginWithPassword('correct horse battery staple');

		expect(setToken).toHaveBeenCalledWith('sess-tok');
		expect(post.mock.calls[0][0]).toBe('/api/auth/password-challenge');
		const [verifyPath, body] = post.mock.calls[1] as [string, Record<string, string>];
		expect(verifyPath).toBe('/api/auth/password-verify');
		expect(body.challenge_id).toBe('pc1');
		// The password is never in the body — only a signature over the nonce.
		expect(JSON.stringify(body)).not.toContain('correct horse battery staple');
		const { publicKeyHex } = await derivePasswordKeyPair('correct horse battery staple', salt);
		expect(
			verifyAuthSignature(publicKeyHex, buildPasswordLoginMessage('facef00d'), body.signature),
		).toBe(true);
	});
});

describe('logout / isAuthenticated', () => {
	test('logout clears the token', () => {
		logout();
		expect(clearToken).toHaveBeenCalledTimes(1);
	});

	test('isAuthenticated reflects whether a token is present', () => {
		getToken.mockReturnValueOnce('tok');
		expect(isAuthenticated()).toBe(true);
		getToken.mockReturnValueOnce(null);
		expect(isAuthenticated()).toBe(false);
	});
});
