import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import {
	createConnection,
	deleteConnection,
	findConnectionByAccount,
	getConnection,
	listConnections,
	oauthSecretName,
	updateTokens,
} from '../src/services/oauth/connection-store';
import { safeClose } from './helpers';
import { createTestApp } from './helpers/app';

/**
 * Branch/line coverage for `services/oauth/connection-store.ts`: secret naming,
 * create (with and without refresh token, upsert-on-conflict, locked vault),
 * get/list/find lookups, delete (reference nulling + secret cleanup), and
 * token refresh (rotate, late refresh-secret creation, expiry updates).
 */

let db: Db;
let masterKeyManager: MasterKeyManager;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	masterKeyManager = ctx.masterKeyManager;
});

afterAll(async () => {
	await safeClose(db);
});

function deps() {
	return { db, masterKeyManager };
}

describe('oauthSecretName', () => {
	it('formats access and refresh names and sanitizes non-alphanumeric provider chars', () => {
		const id = 'abcd1234-5678-90ab-cdef-1234567890ab';
		expect(oauthSecretName('my-provider.v2', id, 'access')).toBe('OAUTH_MY_PROVIDER_V2_ABCD1234');
		expect(oauthSecretName('github', id, 'refresh')).toBe('OAUTH_GITHUB_ABCD1234_REFRESH');
	});
});

describe('createConnection', () => {
	it('stores access + refresh tokens as encrypted secrets scoped to allowed hosts', async () => {
		const conn = await createConnection(deps(), {
			provider: 'acme',
			providerAccountId: 'acme:1',
			providerAccountLabel: 'Acme One',
			accessToken: 'acme-access-token-value',
			refreshToken: 'acme-refresh-token-value',
			scopes: ['read', 'write'],
			expiresAt: new Date(Date.now() + 3_600_000),
			allowedHosts: ['api.acme.test'],
			metadata: { plan: 'pro' },
		});

		expect(conn.provider).toBe('acme');
		expect(conn.providerAccountId).toBe('acme:1');
		expect(conn.providerAccountLabel).toBe('Acme One');
		expect(conn.scopes).toEqual(['read', 'write']);
		expect(conn.expiresAt).toBeTruthy();
		expect(conn.metadata).toEqual({ plan: 'pro' });
		expect(conn.accessTokenSecretName).toMatch(/^OAUTH_ACME_[0-9A-F]{8}$/);
		expect(conn.refreshTokenSecretId).toBeTruthy();

		const secrets = await db.query<{
			id: string;
			name: string;
			allowed_hosts: string[];
			encrypted_value: string;
		}>(
			`SELECT id, name, allowed_hosts, encrypted_value::text AS encrypted_value
			 FROM secrets WHERE id = $1 OR id = $2 ORDER BY name`,
			[conn.accessTokenSecretId, conn.refreshTokenSecretId],
		);
		expect(secrets.rows.length).toBe(2);
		expect(secrets.rows.map((r) => r.name)).toEqual([
			conn.accessTokenSecretName,
			`${conn.accessTokenSecretName}_REFRESH`,
		]);
		for (const row of secrets.rows) {
			expect(row.allowed_hosts).toEqual(['api.acme.test']);
			// Values are encrypted at rest — the plaintext never lands in the row.
			expect(row.encrypted_value).not.toContain('acme-access-token-value');
			expect(row.encrypted_value).not.toContain('acme-refresh-token-value');
		}
	});

	it('creates no refresh secret when no refresh token is supplied', async () => {
		const conn = await createConnection(deps(), {
			provider: 'acme',
			providerAccountId: 'acme:norefresh',
			providerAccountLabel: 'No Refresh',
			accessToken: 'tok-no-refresh',
			scopes: [],
			allowedHosts: ['api.acme.test'],
		});
		expect(conn.refreshTokenSecretId).toBeNull();
		expect(conn.expiresAt).toBeNull();
		const refreshRows = await db.query(`SELECT id FROM secrets WHERE name = $1`, [
			`${conn.accessTokenSecretName}_REFRESH`,
		]);
		expect(refreshRows.rows.length).toBe(0);
	});

	it('upserts on (provider, provider_account_id) conflict, keeping one row and updating fields', async () => {
		const first = await createConnection(deps(), {
			provider: 'acme',
			providerAccountId: 'acme:dup',
			providerAccountLabel: 'Original',
			accessToken: 'tok-one',
			scopes: ['read'],
			allowedHosts: ['api.acme.test'],
		});
		const second = await createConnection(deps(), {
			provider: 'acme',
			providerAccountId: 'acme:dup',
			providerAccountLabel: 'Replaced',
			accessToken: 'tok-two',
			scopes: ['read', 'admin'],
			allowedHosts: ['api.acme.test'],
		});

		// Same logical connection: the original row id survives, fields update.
		expect(second.id).toBe(first.id);
		expect(second.providerAccountLabel).toBe('Replaced');
		expect(second.scopes).toEqual(['read', 'admin']);
		const rows = await db.query(
			`SELECT id FROM oauth_connections WHERE provider = 'acme' AND provider_account_id = 'acme:dup'`,
		);
		expect(rows.rows.length).toBe(1);
	});

	it('throws when the master key is locked', async () => {
		const locked = new MasterKeyManager();
		await expect(
			createConnection(
				{ db, masterKeyManager: locked },
				{
					provider: 'acme',
					providerAccountId: 'acme:locked',
					providerAccountLabel: 'Locked',
					accessToken: 'tok-locked',
					scopes: [],
					allowedHosts: ['api.acme.test'],
				},
			),
		).rejects.toThrow(/Master key is locked/);
	});
});

describe('getConnection / listConnections / findConnectionByAccount', () => {
	it('getConnection returns the mapped row and null for an unknown id', async () => {
		const created = await createConnection(deps(), {
			provider: 'lookup',
			providerAccountId: 'lookup:1',
			providerAccountLabel: 'Lookup',
			accessToken: 'tok-lookup',
			scopes: ['a'],
			allowedHosts: ['lookup.test'],
			metadata: { k: 'v' },
		});
		const fetched = await getConnection(deps(), created.id);
		expect(fetched).not.toBeNull();
		expect(fetched?.provider).toBe('lookup');
		expect(fetched?.accessTokenSecretName).toBe(created.accessTokenSecretName);
		expect(fetched?.metadata).toEqual({ k: 'v' });

		expect(await getConnection(deps(), randomUUID())).toBeNull();
	});

	it('listConnections returns all connections', async () => {
		const list = await listConnections(deps());
		expect(list.length).toBeGreaterThanOrEqual(2);
		const providers = list.map((c) => c.provider);
		expect(providers).toContain('acme');
		expect(providers).toContain('lookup');
	});

	it('findConnectionByAccount resolves by provider + account id and null when absent', async () => {
		const found = await findConnectionByAccount(deps(), 'lookup', 'lookup:1');
		expect(found?.providerAccountLabel).toBe('Lookup');
		expect(await findConnectionByAccount(deps(), 'lookup', 'lookup:nope')).toBeNull();
	});
});

describe('deleteConnection', () => {
	it('nulls repo/mcp references, removes both secret rows, and deletes the connection', async () => {
		const conn = await createConnection(deps(), {
			provider: 'todelete',
			providerAccountId: 'del:1',
			providerAccountLabel: 'ToDelete',
			accessToken: 'tok-del',
			refreshToken: 'ref-del',
			scopes: [],
			allowedHosts: ['del.test'],
		});

		// Reference the connection from a repo and an MCP connector row.
		const project = await db.query<{ id: string }>(`SELECT id FROM projects LIMIT 1`);
		const repo = await db.query<{ id: string }>(
			`INSERT INTO repos (project_id, repo_identifier, host_type, oauth_connection_id)
			 VALUES ($1, 'octo/deleteme', 'github', $2) RETURNING id`,
			[project.rows[0].id, conn.id],
		);
		const mcp = await db.query<{ id: string }>(
			`INSERT INTO mcp_connections (name, display_name, kind, config, oauth_connection_id)
			 VALUES ('store-del-conn', 'Store Del', 'saas'::mcp_connection_kind, '{}'::jsonb, $1)
			 RETURNING id`,
			[conn.id],
		);

		const deleted = await deleteConnection(deps(), conn.id);
		expect(deleted).toBe(true);

		const gone = await db.query(`SELECT id FROM oauth_connections WHERE id = $1`, [conn.id]);
		expect(gone.rows.length).toBe(0);
		const secrets = await db.query(`SELECT id FROM secrets WHERE id = $1 OR id = $2`, [
			conn.accessTokenSecretId,
			conn.refreshTokenSecretId,
		]);
		expect(secrets.rows.length).toBe(0);
		const repoRow = await db.query<{ oauth_connection_id: string | null }>(
			`SELECT oauth_connection_id FROM repos WHERE id = $1`,
			[repo.rows[0].id],
		);
		expect(repoRow.rows[0].oauth_connection_id).toBeNull();
		const mcpRow = await db.query<{ oauth_connection_id: string | null }>(
			`SELECT oauth_connection_id FROM mcp_connections WHERE id = $1`,
			[mcp.rows[0].id],
		);
		expect(mcpRow.rows[0].oauth_connection_id).toBeNull();
	});

	it('returns false for an unknown connection id', async () => {
		expect(await deleteConnection(deps(), randomUUID())).toBe(false);
	});
});

describe('updateTokens', () => {
	it('throws when the master key is locked', async () => {
		const locked = new MasterKeyManager();
		await expect(
			updateTokens(
				{ db, masterKeyManager: locked },
				{ connectionId: randomUUID(), accessToken: 'x' },
			),
		).rejects.toThrow(/Master key is locked/);
	});

	it('throws for an unknown connection id', async () => {
		const missing = randomUUID();
		await expect(updateTokens(deps(), { connectionId: missing, accessToken: 'x' })).rejects.toThrow(
			new RegExp(`${missing} not found`),
		);
	});

	it('rotates access + refresh tokens in place and updates expires_at', async () => {
		const conn = await createConnection(deps(), {
			provider: 'rotate',
			providerAccountId: 'rot:1',
			providerAccountLabel: 'Rotate',
			accessToken: 'rot-access-old',
			refreshToken: 'rot-refresh-old',
			scopes: [],
			allowedHosts: ['rot.test'],
		});
		const before = await db.query<{ id: string; encrypted_value: string }>(
			`SELECT id, encrypted_value::text AS encrypted_value FROM secrets WHERE id = $1 OR id = $2`,
			[conn.accessTokenSecretId, conn.refreshTokenSecretId],
		);

		const expiresAt = new Date(Date.now() + 60_000);
		await updateTokens(deps(), {
			connectionId: conn.id,
			accessToken: 'rot-access-new',
			refreshToken: 'rot-refresh-new',
			expiresAt,
		});

		const after = await db.query<{ id: string; encrypted_value: string }>(
			`SELECT id, encrypted_value::text AS encrypted_value FROM secrets WHERE id = $1 OR id = $2`,
			[conn.accessTokenSecretId, conn.refreshTokenSecretId],
		);
		for (const row of after.rows) {
			const prev = before.rows.find((b) => b.id === row.id);
			expect(row.encrypted_value).not.toBe(prev?.encrypted_value);
			expect(row.encrypted_value).not.toContain('rot-access-new');
			expect(row.encrypted_value).not.toContain('rot-refresh-new');
		}
		const connRow = await db.query<{ expires_at: Date | null }>(
			`SELECT expires_at FROM oauth_connections WHERE id = $1`,
			[conn.id],
		);
		expect(connRow.rows[0].expires_at).toBeTruthy();
	});

	it('creates a refresh secret (inheriting allowed_hosts) when the connection had none', async () => {
		const conn = await createConnection(deps(), {
			provider: 'laterefresh',
			providerAccountId: 'late:1',
			providerAccountLabel: 'LateRefresh',
			accessToken: 'late-access',
			scopes: [],
			allowedHosts: ['late.test'],
		});
		expect(conn.refreshTokenSecretId).toBeNull();

		await updateTokens(deps(), {
			connectionId: conn.id,
			accessToken: 'late-access-2',
			refreshToken: 'late-refresh-1',
		});

		const updated = await getConnection(deps(), conn.id);
		expect(updated?.refreshTokenSecretId).toBeTruthy();
		// expires_at was not supplied → reset to null.
		expect(updated?.expiresAt).toBeNull();
		const refreshSecret = await db.query<{ name: string; allowed_hosts: string[] }>(
			`SELECT name, allowed_hosts FROM secrets WHERE id = $1`,
			[updated?.refreshTokenSecretId],
		);
		expect(refreshSecret.rows[0].name).toBe(`${conn.accessTokenSecretName}_REFRESH`);
		expect(refreshSecret.rows[0].allowed_hosts).toEqual(['late.test']);
	});

	it('rotates only the access token when no refresh token is supplied', async () => {
		const conn = await createConnection(deps(), {
			provider: 'accessonly',
			providerAccountId: 'ao:1',
			providerAccountLabel: 'AccessOnly',
			accessToken: 'ao-old',
			scopes: [],
			allowedHosts: ['ao.test'],
		});
		await updateTokens(deps(), { connectionId: conn.id, accessToken: 'ao-new' });
		const updated = await getConnection(deps(), conn.id);
		expect(updated?.refreshTokenSecretId).toBeNull();
	});
});
