import type { PGlite } from '@electric-sql/pglite';
import { PlatformType } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../../crypto/master-key';
import type { Env } from '../../lib/types';
import { getConnection, getOAuthToken, storeOAuthToken } from '../../services/token-store';
import { safeClose } from '../helpers';
import { authHeader, createTestApp } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let boardToken: string;
let masterKeyManager: MasterKeyManager;
let companyId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	boardToken = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const typesRes = await app.request('/api/company-types', { headers: authHeader(boardToken) });
	const typeId = (await typesRes.json()).data.find((t: any) => t.name === 'Startup').id;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Token Store Co', template_id: typeId, issue_prefix: 'TS' }),
	});
	companyId = (await companyRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('storeOAuthToken', () => {
	it('stores and encrypts an OAuth token', async () => {
		const secretId = await storeOAuthToken(
			db,
			masterKeyManager,
			companyId,
			PlatformType.GitHub,
			'ghp_test_access_token_123',
			'repo,user',
			{ login: 'testuser' },
		);

		expect(secretId).toBeDefined();
		expect(typeof secretId).toBe('string');

		// Verify the secret was stored encrypted (not plaintext)
		const secret = await db.query<{ encrypted_value: string; name: string }>(
			'SELECT encrypted_value, name FROM secrets WHERE id = $1',
			[secretId],
		);
		expect(secret.rows[0].name).toBe('github_access_token');
		expect(secret.rows[0].encrypted_value).not.toBe('ghp_test_access_token_123');
		expect(secret.rows[0].encrypted_value.length).toBeGreaterThan(0);
	});

	it('creates a connected_platforms record', async () => {
		const result = await db.query<{ platform: string; status: string; scopes: string }>(
			'SELECT platform, status, scopes FROM connected_platforms WHERE company_id = $1 AND platform = $2::platform_type',
			[companyId, PlatformType.GitHub],
		);
		expect(result.rows.length).toBe(1);
		expect(result.rows[0].status).toBe('active');
		expect(result.rows[0].scopes).toBe('repo,user');
	});

	it('upserts on duplicate platform', async () => {
		await storeOAuthToken(
			db,
			masterKeyManager,
			companyId,
			PlatformType.GitHub,
			'ghp_updated_token_456',
			'repo,user,admin',
			{ login: 'updateduser' },
		);

		// Should still be one record, not two
		const result = await db.query<{ count: string }>(
			'SELECT COUNT(*) as count FROM connected_platforms WHERE company_id = $1 AND platform = $2::platform_type',
			[companyId, PlatformType.GitHub],
		);
		expect(Number(result.rows[0].count)).toBe(1);

		// Should have updated scopes
		const platform = await db.query<{ scopes: string }>(
			'SELECT scopes FROM connected_platforms WHERE company_id = $1 AND platform = $2::platform_type',
			[companyId, PlatformType.GitHub],
		);
		expect(platform.rows[0].scopes).toBe('repo,user,admin');
	});
});

describe('getOAuthToken', () => {
	it('retrieves and decrypts a stored token', async () => {
		const token = await getOAuthToken(db, masterKeyManager, companyId, PlatformType.GitHub);
		expect(token).toBe('ghp_updated_token_456');
	});

	it('returns null for non-existent platform', async () => {
		const token = await getOAuthToken(db, masterKeyManager, companyId, PlatformType.GitLab);
		expect(token).toBeNull();
	});
});

describe('getConnection', () => {
	it('returns connection info for an existing platform', async () => {
		const conn = await getConnection(db, companyId, PlatformType.GitHub);
		expect(conn).not.toBeNull();
		expect(conn!.platform).toBe('github');
		expect(conn!.status).toBe('active');
		expect(conn!.scopes).toBe('repo,user,admin');
		expect(conn!.metadata).toEqual({ login: 'updateduser' });
	});

	it('returns null for non-existent platform', async () => {
		const conn = await getConnection(db, companyId, PlatformType.GitLab);
		expect(conn).toBeNull();
	});

	it('returns null for non-existent company', async () => {
		const conn = await getConnection(
			db,
			'00000000-0000-0000-0000-000000000000',
			PlatformType.GitHub,
		);
		expect(conn).toBeNull();
	});
});
