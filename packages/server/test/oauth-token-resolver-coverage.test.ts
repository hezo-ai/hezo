import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { decrypt } from '../src/crypto/encryption';
import type { MasterKeyManager } from '../src/crypto/master-key';
import { setLogLevel } from '../src/logger';
import {
	createConnection,
	getConnection,
	type OAuthConnectionRow,
} from '../src/services/oauth/connection-store';
import {
	clearRefreshFns,
	type RefreshFn,
	refreshConnection,
	refreshExpiringTokens,
	registerRefreshFn,
} from '../src/services/oauth/token-resolver';
import { safeClose } from './helpers';
import { createTestApp } from './helpers/app';

let db: PGlite;
let masterKeyManager: MasterKeyManager;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	masterKeyManager = ctx.masterKeyManager;
});

afterEach(() => {
	clearRefreshFns();
});

/** Run a body with the logger raised to `error` so an intentional skip-warn
 * (connection-not-found, locked-key) stays out of the quiet test output. */
async function withoutWarns<T>(fn: () => Promise<T>): Promise<T> {
	setLogLevel('error');
	try {
		return await fn();
	} finally {
		setLogLevel('warn');
	}
}

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

describe('refreshExpiringTokens — no-candidate / unregistered-provider branches', () => {
	it('returns early (no provider call) when nothing is near expiry', async () => {
		// No expired connections with refresh tokens → candidates is empty.
		let called = false;
		registerRefreshFn('never-fires', async () => {
			called = true;
			return { accessToken: 'x' };
		});
		await refreshExpiringTokens({ db, masterKeyManager });
		expect(called).toBe(false);
	});

	it('skips an expired candidate whose provider has no registered refresh fn', async () => {
		const conn = await makeConnection({
			provider: 'no-fn-provider',
			providerAccountId: 'acct',
			expiresAt: new Date(Date.now() - 1_000),
			withRefresh: true,
		});
		// No registerRefreshFn for 'no-fn-provider' → the .filter() drops it before
		// any refresh round-trip; the stale token is left in place.
		await refreshExpiringTokens({ db, masterKeyManager });
		const after = await getConnection({ db, masterKeyManager }, conn.id);
		const key = masterKeyManager.getKey();
		if (!key) throw new Error('master key locked');
		const accessRow = await db.query<{ encrypted_value: string }>(
			`SELECT encrypted_value FROM secrets WHERE id = $1`,
			[after?.accessTokenSecretId],
		);
		expect(decrypt(accessRow.rows[0].encrypted_value, key)).toBe('access-stale');
	});
});

describe('refreshConnection — direct doRefresh guards', () => {
	it('no-ops for an unknown connection id (connection not found)', async () => {
		await withoutWarns(() =>
			expect(
				refreshConnection({ db, masterKeyManager }, '00000000-0000-0000-0000-000000000000'),
			).resolves.toBeUndefined(),
		);
	});

	it('no-ops when the connection provider has no registered fn', async () => {
		const conn = await makeConnection({
			provider: 'unregistered',
			providerAccountId: 'acct2',
			expiresAt: new Date(Date.now() - 1_000),
			withRefresh: true,
		});
		await expect(refreshConnection({ db, masterKeyManager }, conn.id)).resolves.toBeUndefined();
	});

	it('no-ops when the connection has no refresh token', async () => {
		const conn = await makeConnection({
			provider: 'has-fn-no-refresh',
			providerAccountId: 'acct3',
			expiresAt: new Date(Date.now() - 1_000),
			withRefresh: false,
		});
		let called = false;
		registerRefreshFn('has-fn-no-refresh', async () => {
			called = true;
			return { accessToken: 'x' };
		});
		await refreshConnection({ db, masterKeyManager }, conn.id);
		// refreshTokenSecretId is null → guard returns before invoking the fn.
		expect(called).toBe(false);
	});

	it('updates tokens with null refreshToken/expiresAt when the fn omits them', async () => {
		const conn = await makeConnection({
			provider: 'minimal-result',
			providerAccountId: 'acct4',
			expiresAt: new Date(Date.now() - 1_000),
			withRefresh: true,
		});
		const refreshFn: RefreshFn = async () => ({ accessToken: 'rotated-only' });
		registerRefreshFn('minimal-result', refreshFn);

		await refreshConnection({ db, masterKeyManager }, conn.id);

		const after = await getConnection({ db, masterKeyManager }, conn.id);
		expect(after?.expiresAt).toBeNull();
		const key = masterKeyManager.getKey();
		if (!key) throw new Error('master key locked');
		const accessRow = await db.query<{ encrypted_value: string }>(
			`SELECT encrypted_value FROM secrets WHERE id = $1`,
			[after?.accessTokenSecretId],
		);
		expect(decrypt(accessRow.rows[0].encrypted_value, key)).toBe('rotated-only');
	});

	it('skips refresh when the master key is locked (cannot decrypt refresh token)', async () => {
		const conn = await makeConnection({
			provider: 'locked-key',
			providerAccountId: 'acct5',
			expiresAt: new Date(Date.now() - 1_000),
			withRefresh: true,
		});
		let called = false;
		registerRefreshFn('locked-key', async () => {
			called = true;
			return { accessToken: 'should-not-run' };
		});

		// Simulate a locked master key: loadSecretValue returns null so the
		// refresh fn is never invoked.
		const realKey = masterKeyManager.getKey();
		const lockedManager = {
			getKey: () => null,
		} as unknown as MasterKeyManager;

		await withoutWarns(() => refreshConnection({ db, masterKeyManager: lockedManager }, conn.id));
		expect(called).toBe(false);
		expect(realKey).not.toBeNull();
	});
});
