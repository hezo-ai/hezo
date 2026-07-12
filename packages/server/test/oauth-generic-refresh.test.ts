import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { decrypt } from '../src/crypto/encryption';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import { createConnection, getConnection } from '../src/services/oauth/connection-store';
import { registerGenericOAuthRefresh } from '../src/services/oauth/generic-refresh';
import { clearRefreshFns, refreshExpiringTokens } from '../src/services/oauth/token-resolver';
import { safeClose } from './helpers';
import { createTestApp } from './helpers/app';

let db: Db;
let masterKeyManager: MasterKeyManager;
const realFetch = globalThis.fetch;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	masterKeyManager = ctx.masterKeyManager;
});

afterEach(() => {
	clearRefreshFns();
	globalThis.fetch = realFetch;
});

afterAll(async () => {
	await safeClose(db);
});

/**
 * End-to-end proof the generic host-side refresh is real in prod: register the
 * actual `genericRefreshFn` (as startup does), seed a broker-style connection
 * (token_url + client_id in metadata, an encrypted client secret, a refresh
 * token, expiring inside the window), stub the token endpoint, and confirm
 * `refreshExpiringTokens` mints and stores a fresh access token — with the
 * client secret sent host-side to the token endpoint but never egress-scoped.
 */
describe('generic host-side OAuth refresh', () => {
	it('refreshes a broker connection with no provider-specific fn', async () => {
		registerGenericOAuthRefresh();

		const conn = await createConnection(
			{ db, masterKeyManager },
			{
				provider: 'google-youtube',
				providerAccountId: 'google-youtube:acct',
				providerAccountLabel: 'YouTube',
				accessToken: 'ya29.stale',
				refreshToken: '1//refresh-old',
				scopes: ['https://www.googleapis.com/auth/youtube'],
				expiresAt: new Date(Date.now() - 1_000),
				allowedHosts: ['*.googleapis.com'],
				clientSecret: 'GOCSPX-clientsecret',
				metadata: {
					token_url: 'https://oauth2.googleapis.com/token',
					client_id: 'gcid.apps.googleusercontent.com',
				},
			},
		);

		let capturedBody = '';
		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			capturedBody = String(init?.body);
			return new Response(JSON.stringify({ access_token: 'ya29.fresh', expires_in: 3600 }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}) as typeof globalThis.fetch;

		await refreshExpiringTokens({ db, masterKeyManager });

		// The refresh grant carried the decrypted client secret + refresh token host-side.
		expect(capturedBody).toContain('grant_type=refresh_token');
		expect(capturedBody).toContain('client_id=gcid.apps.googleusercontent.com');
		expect(capturedBody).toContain('client_secret=GOCSPX-clientsecret');
		expect(capturedBody).toContain('refresh_token=1%2F%2Frefresh-old');

		const refreshed = await getConnection({ db, masterKeyManager }, conn.id);
		expect(refreshed?.expiresAt?.getTime()).toBeGreaterThan(Date.now());
		const key = masterKeyManager.getKey();
		if (!key) throw new Error('master key locked');
		const accessRow = await db.query<{ encrypted_value: string }>(
			`SELECT encrypted_value FROM secrets WHERE id = $1`,
			[refreshed?.accessTokenSecretId],
		);
		expect(decrypt(accessRow.rows[0].encrypted_value, key)).toBe('ya29.fresh');
	});

	it('stores the client secret host-only — empty allowed_hosts, never egress-substitutable', async () => {
		const conn = await createConnection(
			{ db, masterKeyManager },
			{
				provider: 'google-youtube',
				providerAccountId: 'google-youtube:acct2',
				providerAccountLabel: 'YouTube 2',
				accessToken: 'ya29.a',
				refreshToken: '1//r',
				scopes: [],
				allowedHosts: ['*.googleapis.com'],
				clientSecret: 'GOCSPX-hostonly',
				metadata: { token_url: 'https://oauth2.googleapis.com/token', client_id: 'x' },
			},
		);
		const full = await getConnection({ db, masterKeyManager }, conn.id);
		expect(full?.clientSecretSecretId).toBeTruthy();
		const secret = await db.query<{ allowed_hosts: string[]; allow_all_hosts: boolean }>(
			`SELECT allowed_hosts, allow_all_hosts FROM secrets WHERE id = $1`,
			[full?.clientSecretSecretId],
		);
		// Empty allowed_hosts + allow_all_hosts=false → the egress proxy can never
		// substitute it into any request, so it can never enter a run (red line).
		expect(secret.rows[0].allowed_hosts).toEqual([]);
		expect(secret.rows[0].allow_all_hosts).toBe(false);
	});

	it('does not attempt a refresh when the connection lacks token_url/client_id metadata', async () => {
		registerGenericOAuthRefresh();
		const conn = await createConnection(
			{ db, masterKeyManager },
			{
				provider: 'legacy-no-meta',
				providerAccountId: 'legacy:acct',
				providerAccountLabel: 'Legacy',
				accessToken: 'stale',
				refreshToken: 'r',
				scopes: [],
				expiresAt: new Date(Date.now() - 1_000),
				allowedHosts: ['example.com'],
				// no token_url/client_id in metadata
			},
		);
		let called = false;
		globalThis.fetch = (async () => {
			called = true;
			return new Response('{}', { status: 200 });
		}) as typeof globalThis.fetch;

		// The generic fn throws "needs token_url + client_id"; doRefresh swallows it,
		// so the hot path never rejects and the stale token is left untouched.
		await expect(refreshExpiringTokens({ db, masterKeyManager })).resolves.toBeUndefined();
		expect(called).toBe(false);
		const after = await getConnection({ db, masterKeyManager }, conn.id);
		const key = masterKeyManager.getKey();
		if (!key) throw new Error('master key locked');
		const accessRow = await db.query<{ encrypted_value: string }>(
			`SELECT encrypted_value FROM secrets WHERE id = $1`,
			[after?.accessTokenSecretId],
		);
		expect(decrypt(accessRow.rows[0].encrypted_value, key)).toBe('stale');
	});
});
