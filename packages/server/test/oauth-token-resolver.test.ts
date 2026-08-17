import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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

	it('stops retrying a grant that can never be refreshed again', async () => {
		// Two connections on a live instance sat at 51 attempts and climbing, four
		// times an hour, forever: `invalid_grant` needs a human to reconnect and a
		// connection missing its token endpoint was never able to refresh at all.
		// Neither improves with another attempt.
		await makeConnection({
			provider: 'p-dead',
			providerAccountId: 'a-dead',
			expiresAt: new Date(Date.now() - 1_000),
			withRefresh: true,
		});
		let calls = 0;
		registerRefreshFn('p-dead', async () => {
			calls++;
			throw new Error('token endpoint error: invalid_grant - re-authentication required');
		});

		await refreshExpiringTokens({ db, masterKeyManager });
		expect(calls).toBe(1);

		// Jump well past the 15-minute backoff ceiling. Without the park this is
		// exactly when the next of the 51 attempts would fire; with it there is no
		// next attempt at all.
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date(Date.now() + 60 * 60_000));
			await refreshExpiringTokens({ db, masterKeyManager });
			await refreshExpiringTokens({ db, masterKeyManager });
		} finally {
			vi.useRealTimers();
		}
		expect(calls).toBe(1);
	});

	it('retries a transient refresh failure once its backoff elapses', async () => {
		// The park must not swallow the ordinary case, which is what the backoff is
		// for.
		await makeConnection({
			provider: 'p-flaky',
			providerAccountId: 'a-flaky',
			expiresAt: new Date(Date.now() - 1_000),
			withRefresh: true,
		});
		let calls = 0;
		registerRefreshFn('p-flaky', async () => {
			calls++;
			throw new Error('socket hang up');
		});

		await refreshExpiringTokens({ db, masterKeyManager });
		expect(calls).toBe(1);
		// Backed off, not parked: the same jump that proves the park above must let
		// this one through, or the park has swallowed the ordinary case.
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date(Date.now() + 60 * 60_000));
			await refreshExpiringTokens({ db, masterKeyManager });
		} finally {
			vi.useRealTimers();
		}
		expect(calls).toBe(2);
	});

	it('un-parks a connection once it is reconnected', async () => {
		const conn = await makeConnection({
			provider: 'p-reconnect',
			providerAccountId: 'a-reconnect',
			expiresAt: new Date(Date.now() - 1_000),
			withRefresh: true,
		});
		let calls = 0;
		registerRefreshFn('p-reconnect', async () => {
			calls++;
			throw new Error('token endpoint error: invalid_grant');
		});

		await refreshExpiringTokens({ db, masterKeyManager });
		expect(calls).toBe(1);
		await refreshExpiringTokens({ db, masterKeyManager });
		expect(calls).toBe(1);

		// Reconnecting moves `updated_at`, which is what clears the park - no hook
		// on the reconnect path to remember or to go stale.
		await db.query(
			`UPDATE oauth_connections SET updated_at = now() + interval '1 second' WHERE id = $1`,
			[conn.id],
		);
		await refreshExpiringTokens({ db, masterKeyManager });
		expect(calls).toBe(2);
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

describe('failed-refresh backoff', () => {
	it('attempts a failing connection once, then skips it on the next sweep', async () => {
		const conn = await makeConnection({
			provider: 'backoff-1',
			providerAccountId: 'b1',
			expiresAt: new Date(Date.now() - 1_000),
			withRefresh: true,
		});
		let attempts = 0;
		registerRefreshFn('backoff-1', async () => {
			attempts += 1;
			throw new Error('token endpoint exploded');
		});

		// The sweep runs on every proxied request; without a backoff each of these
		// would re-attempt (and re-log) because a failure never advances expires_at.
		await refreshExpiringTokens({ db, masterKeyManager });
		await refreshExpiringTokens({ db, masterKeyManager });
		await refreshExpiringTokens({ db, masterKeyManager });

		expect(attempts).toBe(1);
		// Still a candidate — the row is untouched, it is the backoff holding it back.
		const after = await getConnection({ db, masterKeyManager }, conn.id);
		expect(after?.expiresAt?.getTime()).toBeLessThan(Date.now());
	});

	it('does not hold back a different connection', async () => {
		await makeConnection({
			provider: 'backoff-2',
			providerAccountId: 'b2',
			expiresAt: new Date(Date.now() - 1_000),
			withRefresh: true,
		});
		await makeConnection({
			provider: 'backoff-3',
			providerAccountId: 'b3',
			expiresAt: new Date(Date.now() - 1_000),
			withRefresh: true,
		});
		let healthy = 0;
		registerRefreshFn('backoff-2', async () => {
			throw new Error('nope');
		});
		registerRefreshFn('backoff-3', async () => {
			healthy += 1;
			return { accessToken: 'fresh', expiresAt: new Date(Date.now() + 3_600_000) };
		});

		await refreshExpiringTokens({ db, masterKeyManager });
		await refreshExpiringTokens({ db, masterKeyManager });

		// The healthy one leaves the candidate set by being refreshed, not by backoff.
		expect(healthy).toBe(1);
	});

	it('clears the backoff once a refresh succeeds', async () => {
		await makeConnection({
			provider: 'backoff-4',
			providerAccountId: 'b4',
			expiresAt: new Date(Date.now() - 1_000),
			withRefresh: true,
		});
		let calls = 0;
		registerRefreshFn('backoff-4', async () => {
			calls += 1;
			if (calls === 1) throw new Error('transient');
			return { accessToken: 'fresh', expiresAt: new Date(Date.now() + 3_600_000) };
		});

		await refreshExpiringTokens({ db, masterKeyManager });
		expect(calls).toBe(1);
		// Suppressed while backed off…
		await refreshExpiringTokens({ db, masterKeyManager });
		expect(calls).toBe(1);
		// …and clearRefreshFns resets the backoff state between tests, so a fresh
		// registration is attempted again rather than inheriting the old timer.
		clearRefreshFns();
		registerRefreshFn('backoff-4', async () => {
			calls += 1;
			return { accessToken: 'fresh', expiresAt: new Date(Date.now() + 3_600_000) };
		});
		await refreshExpiringTokens({ db, masterKeyManager });
		expect(calls).toBe(2);
	});

	it('records the failure on the backing connector and clears it on success', async () => {
		const conn = await makeConnection({
			provider: 'backoff-5',
			providerAccountId: 'b5',
			expiresAt: new Date(Date.now() - 1_000),
			withRefresh: true,
		});
		await db.query(
			`INSERT INTO mcp_connections (name, kind, config, oauth_connection_id)
			 VALUES ('backoff-connector', 'saas', '{}'::jsonb, $1)`,
			[conn.id],
		);

		registerRefreshFn('backoff-5', async () => {
			throw new Error('generic refresh needs token_url + client_id in connection metadata');
		});
		await refreshExpiringTokens({ db, masterKeyManager });

		const failed = await db.query<{ auth_error: string | null }>(
			`SELECT auth_error FROM mcp_connections WHERE oauth_connection_id = $1`,
			[conn.id],
		);
		expect(failed.rows[0].auth_error).toContain('token refresh');
		expect(failed.rows[0].auth_error).toContain('token_url + client_id');

		clearRefreshFns();
		registerRefreshFn('backoff-5', async () => ({
			accessToken: 'fresh',
			expiresAt: new Date(Date.now() + 3_600_000),
		}));
		await refreshExpiringTokens({ db, masterKeyManager });

		const recovered = await db.query<{ auth_error: string | null }>(
			`SELECT auth_error FROM mcp_connections WHERE oauth_connection_id = $1`,
			[conn.id],
		);
		expect(recovered.rows[0].auth_error).toBe(null);
	});
});

/**
 * The bounds the periodic `connector-health` cron relies on. The egress path
 * calls this with no options and a naturally tiny candidate set; the sweep calls
 * it with a wide horizon on a timer, which is what makes each of these matter.
 */
describe('refreshExpiringTokens sweep bounds', () => {
	it('caps candidates per call and takes the soonest-to-expire first', async () => {
		// The starvation bug a LIMIT without an ORDER BY produces: the same
		// arbitrary N rows come back every tick and the rest never refresh at all.
		// Seeded newest-first so insertion order cannot accidentally satisfy this.
		const far = await makeConnection({
			provider: 'sweep-order',
			providerAccountId: 'far',
			expiresAt: new Date(Date.now() + 5 * 60_000),
			withRefresh: true,
		});
		const near = await makeConnection({
			provider: 'sweep-order',
			providerAccountId: 'near',
			expiresAt: new Date(Date.now() - 60_000),
			withRefresh: true,
		});

		const refreshed: string[] = [];
		registerRefreshFn('sweep-order', async (connection) => {
			refreshed.push(connection.providerAccountId);
			return { accessToken: 'new', expiresAt: new Date(Date.now() + 3_600_000) };
		});

		await refreshExpiringTokens({ db, masterKeyManager }, { horizonMs: 10 * 60_000, limit: 1 });

		expect(refreshed).toEqual(['near']);
		// And the one it skipped is still due, so the next tick picks it up rather
		// than the limit permanently hiding it.
		const skipped = await getConnection({ db, masterKeyManager }, far.id);
		expect(skipped?.expiresAt?.getTime()).toBeLessThan(Date.now() + 10 * 60_000);
		expect(near).toBeDefined();
	});

	it('refreshes a token expiring between ticks, which the default window would miss', async () => {
		// The horizon has to exceed the sweep's own interval or a token that lapses
		// mid-interval is renewed only after it has already expired.
		const conn = await makeConnection({
			provider: 'sweep-horizon',
			providerAccountId: 'soon',
			expiresAt: new Date(Date.now() + 5 * 60_000),
			withRefresh: true,
		});
		let calls = 0;
		registerRefreshFn('sweep-horizon', async () => {
			calls++;
			return { accessToken: 'new', expiresAt: new Date(Date.now() + 3_600_000) };
		});

		// Default 60s window: not yet due.
		await refreshExpiringTokens({ db, masterKeyManager });
		expect(calls).toBe(0);

		await refreshExpiringTokens({ db, masterKeyManager }, { horizonMs: 10 * 60_000 });
		expect(calls).toBe(1);
		const refreshed = await getConnection({ db, masterKeyManager }, conn.id);
		expect(refreshed?.expiresAt?.getTime()).toBeGreaterThan(Date.now() + 30 * 60_000);
	});

	it('bounds how many provider round-trips are in flight at once', async () => {
		// Each refresh is a provider round-trip plus a secret read and decrypt, and
		// those decrypts queue behind the one serialized DB handle the process
		// shares - so a wide horizon must not fan out unbounded.
		for (let i = 0; i < 6; i++) {
			await makeConnection({
				provider: 'sweep-conc',
				providerAccountId: `c${i}`,
				expiresAt: new Date(Date.now() - 1_000),
				withRefresh: true,
			});
		}
		let inFlight = 0;
		let peak = 0;
		registerRefreshFn('sweep-conc', async () => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((r) => setTimeout(r, 5));
			inFlight--;
			return { accessToken: 'new', expiresAt: new Date(Date.now() + 3_600_000) };
		});

		await refreshExpiringTokens({ db, masterKeyManager }, { limit: 6, concurrency: 2 });
		expect(peak).toBeLessThanOrEqual(2);
	});
});
