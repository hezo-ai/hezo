import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { decrypt } from '../../crypto/encryption';
import type { MasterKeyManager } from '../../crypto/master-key';
import {
	createConnection,
	getConnection,
	type OAuthConnectionRow,
} from '../../services/oauth/connection-store';
import {
	clearRefreshFns,
	type RefreshFn,
	refreshExpiringTokensForCompany,
	registerRefreshFn,
} from '../../services/oauth/token-resolver';
import { safeClose } from '../helpers';
import { createTestApp } from '../helpers/app';

let db: PGlite;
let masterKeyManager: MasterKeyManager;
let companyId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	masterKeyManager = ctx.masterKeyManager;

	const company = await db.query<{ id: string }>(
		`INSERT INTO companies (name, slug) VALUES ('Refresh Co', 'refresh-co') RETURNING id`,
	);
	companyId = company.rows[0].id;
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
			companyId,
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

describe('refreshExpiringTokensForCompany', () => {
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

		await refreshExpiringTokensForCompany({ db, masterKeyManager }, companyId);

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

		await refreshExpiringTokensForCompany({ db, masterKeyManager }, companyId);
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

		await refreshExpiringTokensForCompany({ db, masterKeyManager }, companyId);
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
			refreshExpiringTokensForCompany({ db, masterKeyManager }, companyId),
			refreshExpiringTokensForCompany({ db, masterKeyManager }, companyId),
			refreshExpiringTokensForCompany({ db, masterKeyManager }, companyId),
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

		await expect(
			refreshExpiringTokensForCompany({ db, masterKeyManager }, companyId),
		).resolves.toBeUndefined();
	});
});
