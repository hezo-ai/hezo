import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decrypt } from '../../crypto/encryption';
import type { MasterKeyManager } from '../../crypto/master-key';
import {
	createConnection,
	deleteConnection,
	findConnectionByAccount,
	getConnection,
	listConnectionsForCompany,
	oauthSecretName,
	updateTokens,
} from '../../services/oauth/connection-store';
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
		`INSERT INTO companies (name, slug) VALUES ('OAuth Co', 'oauth-co') RETURNING id`,
	);
	companyId = company.rows[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('oauth connection store', () => {
	let connectionId: string;

	it('creates a connection, encrypts the access token, and assigns a deterministic placeholder name', async () => {
		const result = await createConnection(
			{ db, masterKeyManager },
			{
				companyId,
				provider: 'github',
				providerAccountId: '12345',
				providerAccountLabel: 'octocat',
				accessToken: 'gho_real_value',
				scopes: ['repo', 'read:org'],
				allowedHosts: ['github.com', 'api.github.com'],
				metadata: { avatar_url: 'https://avatars/x.png' },
			},
		);

		expect(result.provider).toBe('github');
		expect(result.providerAccountId).toBe('12345');
		expect(result.scopes).toEqual(['repo', 'read:org']);
		expect(result.accessTokenSecretName).toMatch(/^OAUTH_GITHUB_[A-F0-9]{8}$/);
		expect(result.accessTokenSecretName).toBe(oauthSecretName('github', result.id, 'access'));
		expect(result.metadata).toEqual({ avatar_url: 'https://avatars/x.png' });

		const secret = await db.query<{ encrypted_value: string; allowed_hosts: string[] }>(
			`SELECT encrypted_value, allowed_hosts FROM secrets WHERE id = $1`,
			[result.accessTokenSecretId],
		);
		const key = masterKeyManager.getKey();
		if (!key) throw new Error('master key not unlocked in test');
		expect(decrypt(secret.rows[0].encrypted_value, key)).toBe('gho_real_value');
		expect(secret.rows[0].allowed_hosts).toEqual(['github.com', 'api.github.com']);

		connectionId = result.id;
	});

	it('upserts on (company, provider, provider_account_id) — replacing the previous tokens', async () => {
		const result = await createConnection(
			{ db, masterKeyManager },
			{
				companyId,
				provider: 'github',
				providerAccountId: '12345',
				providerAccountLabel: 'octocat-renamed',
				accessToken: 'gho_new_value',
				scopes: ['repo'],
				allowedHosts: ['github.com', 'api.github.com'],
			},
		);

		expect(result.id).toBe(connectionId);
		expect(result.providerAccountLabel).toBe('octocat-renamed');
		expect(result.scopes).toEqual(['repo']);

		const conn = await getConnection({ db, masterKeyManager }, connectionId);
		expect(conn?.providerAccountLabel).toBe('octocat-renamed');
	});

	it('lists connections for a company', async () => {
		const list = await listConnectionsForCompany({ db, masterKeyManager }, companyId);
		expect(list.length).toBe(1);
		expect(list[0].provider).toBe('github');
	});

	it('finds a connection by provider account', async () => {
		const found = await findConnectionByAccount(
			{ db, masterKeyManager },
			companyId,
			'github',
			'12345',
		);
		expect(found?.id).toBe(connectionId);

		const missing = await findConnectionByAccount(
			{ db, masterKeyManager },
			companyId,
			'github',
			'nope',
		);
		expect(missing).toBeNull();
	});

	it('updates tokens, re-encrypting the access value and adding a refresh token if previously absent', async () => {
		await updateTokens(
			{ db, masterKeyManager },
			{
				connectionId,
				accessToken: 'gho_rotated',
				refreshToken: 'ghr_new_refresh',
				expiresAt: new Date(Date.now() + 3_600_000),
			},
		);

		const conn = await getConnection({ db, masterKeyManager }, connectionId);
		expect(conn?.refreshTokenSecretId).toBeTruthy();
		expect(conn?.expiresAt).toBeInstanceOf(Date);

		const key = masterKeyManager.getKey();
		if (!key) throw new Error('master key not unlocked in test');

		const access = await db.query<{ encrypted_value: string }>(
			`SELECT encrypted_value FROM secrets WHERE id = $1`,
			[conn?.accessTokenSecretId],
		);
		expect(decrypt(access.rows[0].encrypted_value, key)).toBe('gho_rotated');

		const refresh = await db.query<{ encrypted_value: string }>(
			`SELECT encrypted_value FROM secrets WHERE id = $1`,
			[conn?.refreshTokenSecretId],
		);
		expect(decrypt(refresh.rows[0].encrypted_value, key)).toBe('ghr_new_refresh');
	});

	it('deletes a connection — also deletes its secret rows and nulls FKs from repos/mcp_connections', async () => {
		await db.query(
			`INSERT INTO projects (company_id, name, slug, issue_prefix) VALUES ($1, 'P', 'p', 'P')`,
			[companyId],
		);
		const proj = await db.query<{ id: string }>(`SELECT id FROM projects WHERE slug = 'p'`);
		const projectId = proj.rows[0].id;

		const repo = await db.query<{ id: string }>(
			`INSERT INTO repos (project_id, short_name, repo_identifier, host_type, oauth_connection_id)
			 VALUES ($1, 'r', 'octocat/x', 'github', $2) RETURNING id`,
			[projectId, connectionId],
		);
		const repoId = repo.rows[0].id;

		await db.query(
			`INSERT INTO mcp_connections (company_id, name, kind, config, oauth_connection_id)
			 VALUES ($1, 'datocms', 'saas', '{}'::jsonb, $2)`,
			[companyId, connectionId],
		);

		const conn = await getConnection({ db, masterKeyManager }, connectionId);
		const accessSecretId = conn?.accessTokenSecretId;
		const refreshSecretId = conn?.refreshTokenSecretId;

		const ok = await deleteConnection({ db, masterKeyManager }, connectionId);
		expect(ok).toBe(true);

		const after = await getConnection({ db, masterKeyManager }, connectionId);
		expect(after).toBeNull();

		const repoAfter = await db.query<{ oauth_connection_id: string | null }>(
			`SELECT oauth_connection_id FROM repos WHERE id = $1`,
			[repoId],
		);
		expect(repoAfter.rows[0].oauth_connection_id).toBeNull();

		const accessGone = await db.query(`SELECT id FROM secrets WHERE id = $1`, [accessSecretId]);
		expect(accessGone.rows.length).toBe(0);
		if (refreshSecretId) {
			const refreshGone = await db.query(`SELECT id FROM secrets WHERE id = $1`, [refreshSecretId]);
			expect(refreshGone.rows.length).toBe(0);
		}
	});

	it('returns false when deleting a non-existent connection', async () => {
		const ok = await deleteConnection(
			{ db, masterKeyManager },
			'00000000-0000-0000-0000-000000000000',
		);
		expect(ok).toBe(false);
	});
});
