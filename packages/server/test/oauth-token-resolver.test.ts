import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { decrypt } from '../src/crypto/encryption';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import {
	createConnection,
	getConnection,
	type OAuthConnectionRow,
} from '../src/services/oauth/connection-store';
import {
	clearRefreshFns,
	type GenericRefreshFn,
	type RefreshFn,
	refreshExpiringTokens,
	registerGenericRefreshFn,
	registerRefreshFn,
} from '../src/services/oauth/token-resolver';
import { safeClose } from './helpers';
import { createTestApp } from './helpers/app';

let db: Db;
let masterKeyManager: MasterKeyManager;
let teamId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	masterKeyManager = ctx.masterKeyManager;

	const team = await db.query<{ id: string }>(
		`INSERT INTO teams (name, slug) VALUES ('Refresh Co', 'refresh-co') RETURNING id`,
	);
	teamId = team.rows[0].id;
});

afterEach(() => {
	clearRefreshFns();
});

afterAll(async () => {
	await safeClose(db);
});

async function makeConnection(opts: {
	provider: string;
	providerAccountId: string;
	expiresAt?: Date | null;
	withRefresh?: boolean;
}): Promise<OAuthConnectionRow> {
	return createConnection(
		{ db, masterKeyManager },
		{
			provider: opts.provider,
			providerAccountId: opts.providerAccountId,
			providerAccountLabel: `${opts.provider}-${opts.providerAccountId}`,
			accessToken: 'access-stale',
			refreshToken: opts.withRefresh ? 'refresh-old' : null,
			scopes: ['scope1'],
			expiresAt: opts.expiresAt ?? null,
			allowedHosts: ['example.com'],
		},
	);
}

describe('refreshExpiringTokens', () => {
	it('refreshes tokens that expire inside the refresh window', async () => {
		const conn = await makeConnection({
			provider: 'p1',
			providerAccountId: 'a1',
			expiresAt: new Date(Date.now() - 1_000),
			withRefresh: true,
		});

		const refreshFn: RefreshFn = async () => ({
			accessToken: 'access-new',
			refreshToken: 'refresh-new',
			expiresAt: new Date(Date.now() + 3_600_000),
		});
		registerRefreshFn('p1', refreshFn);

		await refreshExpiringTokens({ db, masterKeyManager });

		const refreshed = await getConnection({ db, masterKeyManager }, conn.id);
		expect(refreshed?.expiresAt?.getTime()).toBeGreaterThan(Date.now());

		const key = masterKeyManager.getKey();
		if (!key) throw new Error('master key locked');
		const accessRow = await db.query<{ encrypted_value: string }>(
			`SELECT encrypted_value FROM secrets WHERE id = $1`,
			[refreshed?.accessTokenSecretId],
		);
		expect(decrypt(accessRow.rows[0].encrypted_value, key)).toBe('access-new');
	});

	it('skips connections without a refresh token even if expired', async () => {
		const conn = await makeConnection({
			provider: 'p2',
			providerAccountId: 'a2',
			expiresAt: new Date(Date.now() - 1_000),
			withRefresh: false,
		});
		let called = false;
		registerRefreshFn('p2', async () => {
			called = true;
			return { accessToken: 'never' };
		});

		await refreshExpiringTokens({ db, masterKeyManager });
		expect(called).toBe(false);

		const after = await getConnection({ db, masterKeyManager }, conn.id);
		const key = masterKeyManager.getKey();
		if (!key) throw new Error('master key locked');
		const accessRow = await db.query<{ encrypted_value: string }>(
			`SELECT encrypted_value FROM secrets WHERE id = $1`,
			[after?.accessTokenSecretId],
		);
		expect(decrypt(accessRow.rows[0].encrypted_value, key)).toBe('access-stale');
	});

	it('does not refresh tokens that are far from expiry', async () => {
		const conn = await makeConnection({
			provider: 'p3',
			providerAccountId: 'a3',
			expiresAt: new Date(Date.now() + 3_600_000),
			withRefresh: true,
		});
		let called = false;
		registerRefreshFn('p3', async () => {
			called = true;
			return { accessToken: 'wrong' };
		});

		await refreshExpiringTokens({ db, masterKeyManager });
		expect(called).toBe(false);

		const after = await getConnection({ db, masterKeyManager }, conn.id);
		const key = masterKeyManager.getKey();
		if (!key) throw new Error('master key locked');
		const accessRow = await db.query<{ encrypted_value: string }>(
			`SELECT encrypted_value FROM secrets WHERE id = $1`,
			[after?.accessTokenSecretId],
		);
		expect(decrypt(accessRow.rows[0].encrypted_value, key)).toBe('access-stale');
	});

	it('coalesces concurrent refreshes for the same connection', async () => {
		const conn = await makeConnection({
			provider: 'p4',
			providerAccountId: 'a4',
			expiresAt: new Date(Date.now() - 1_000),
			withRefresh: true,
		});

		let calls = 0;
		registerRefreshFn('p4', async () => {
			calls++;
			await new Promise((r) => setTimeout(r, 20));
			return {
				accessToken: 'fresh',
				refreshToken: 'refresh-new',
				expiresAt: new Date(Date.now() + 3_600_000),
			};
		});

		await Promise.all([
			refreshExpiringTokens({ db, masterKeyManager }),
			refreshExpiringTokens({ db, masterKeyManager }),
			refreshExpiringTokens({ db, masterKeyManager }),
		]);

		expect(calls).toBe(1);

		const after = await getConnection({ db, masterKeyManager }, conn.id);
		const key = masterKeyManager.getKey();
		if (!key) throw new Error('master key locked');
		const accessRow = await db.query<{ encrypted_value: string }>(
			`SELECT encrypted_value FROM secrets WHERE id = $1`,
			[after?.accessTokenSecretId],
		);
		expect(decrypt(accessRow.rows[0].encrypted_value, key)).toBe('fresh');
	});

	it('swallows refresh failures so a single bad provider does not block the proxy hot path', async () => {
		await makeConnection({
			provider: 'p5',
			providerAccountId: 'a5',
			expiresAt: new Date(Date.now() - 1_000),
			withRefresh: true,
		});
		registerRefreshFn('p5', async () => {
			throw new Error('upstream 5xx');
		});

		await expect(refreshExpiringTokens({ db, masterKeyManager })).resolves.toBeUndefined();
	});

	it('falls back to the generic fn for a provider with no specific fn', async () => {
		const conn = await makeConnection({
			provider: 'broker-x',
			providerAccountId: 'ax',
			expiresAt: new Date(Date.now() - 1_000),
			withRefresh: true,
		});
		const generic: GenericRefreshFn = async () => ({
			accessToken: 'via-generic',
			refreshToken: 'refresh-new',
			expiresAt: new Date(Date.now() + 3_600_000),
		});
		registerGenericRefreshFn(generic);

		await refreshExpiringTokens({ db, masterKeyManager });

		const key = masterKeyManager.getKey();
		if (!key) throw new Error('master key locked');
		const refreshed = await getConnection({ db, masterKeyManager }, conn.id);
		const accessRow = await db.query<{ encrypted_value: string }>(
			`SELECT encrypted_value FROM secrets WHERE id = $1`,
			[refreshed?.accessTokenSecretId],
		);
		expect(decrypt(accessRow.rows[0].encrypted_value, key)).toBe('via-generic');
	});

	it('prefers a provider-specific fn over the generic fallback', async () => {
		const conn = await makeConnection({
			provider: 'p6',
			providerAccountId: 'a6',
			expiresAt: new Date(Date.now() - 1_000),
			withRefresh: true,
		});
		let genericCalled = false;
		registerGenericRefreshFn(async () => {
			genericCalled = true;
			return { accessToken: 'should-not-win' };
		});
		registerRefreshFn('p6', async () => ({
			accessToken: 'via-provider',
			refreshToken: 'refresh-new',
			expiresAt: new Date(Date.now() + 3_600_000),
		}));

		await refreshExpiringTokens({ db, masterKeyManager });

		expect(genericCalled).toBe(false);
		const key = masterKeyManager.getKey();
		if (!key) throw new Error('master key locked');
		const refreshed = await getConnection({ db, masterKeyManager }, conn.id);
		const accessRow = await db.query<{ encrypted_value: string }>(
			`SELECT encrypted_value FROM secrets WHERE id = $1`,
			[refreshed?.accessTokenSecretId],
		);
		expect(decrypt(accessRow.rows[0].encrypted_value, key)).toBe('via-provider');
	});
});
