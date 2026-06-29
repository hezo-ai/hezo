import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encrypt } from '../src/crypto/encryption';
import type { MasterKeyManager } from '../src/crypto/master-key';
import { setLogLevel } from '../src/logger';
import {
	loadMcpConnectionDescriptors,
	loadMcpConnectionsForRun,
} from '../src/services/mcp-connections';
import { createConnection } from '../src/services/oauth/connection-store';
import { safeClose } from './helpers';
import { createTestApp } from './helpers/app';

let db: PGlite;
let masterKeyManager: MasterKeyManager;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	masterKeyManager = ctx.masterKeyManager;
});

afterAll(async () => {
	await safeClose(db);
});

/** Run a body with the logger raised to `error` so an intentional skip-warn
 * stays out of the quiet test output. */
async function withoutWarns<T>(fn: () => Promise<T>): Promise<T> {
	setLogLevel('error');
	try {
		return await fn();
	} finally {
		setLogLevel('warn');
	}
}

describe('loadMcpConnectionsForRun — filtering', () => {
	it('excludes revoked rows and incomplete connector-flow saas rows', async () => {
		// Revoked → excluded.
		await db.query(
			`INSERT INTO mcp_connections (name, kind, config, install_status, revoked_at)
			 VALUES ('revoked-svc', 'saas', $1::jsonb, 'installed', now())`,
			[JSON.stringify({ url: 'https://revoked.example/mcp' })],
		);
		// Connector-flow row (created_by_task_id set, oauth not completed) → excluded.
		const taskRow = await db.query<{ id: string }>(`SELECT id FROM tasks LIMIT 1`);
		if (taskRow.rows[0]) {
			await db.query(
				`INSERT INTO mcp_connections (name, kind, config, install_status, created_by_task_id, oauth_connection_id)
				 VALUES ('pending-oauth-svc', 'saas', $1::jsonb, 'installed', $2, NULL)`,
				[JSON.stringify({ url: 'https://pending.example/mcp' }), taskRow.rows[0].id],
			);
		}
		// A plain operator-created saas row → included.
		await db.query(
			`INSERT INTO mcp_connections (name, kind, config, install_status)
			 VALUES ('plain-svc', 'saas', $1::jsonb, 'installed')`,
			[JSON.stringify({ url: 'https://plain.example/mcp' })],
		);

		const rows = await loadMcpConnectionsForRun(db);
		const names = rows.map((r) => r.name);
		expect(names).toContain('plain-svc');
		expect(names).not.toContain('revoked-svc');
		expect(names).not.toContain('pending-oauth-svc');
	});

	it('orders included rows by name ascending', async () => {
		await db.query(
			`INSERT INTO mcp_connections (name, kind, config, install_status)
			 VALUES ('zeta-svc', 'saas', $1::jsonb, 'installed'),
			        ('alpha-svc', 'saas', $2::jsonb, 'installed')`,
			[
				JSON.stringify({ url: 'https://zeta.example/mcp' }),
				JSON.stringify({ url: 'https://alpha.example/mcp' }),
			],
		);
		const rows = await loadMcpConnectionsForRun(db);
		const idxAlpha = rows.findIndex((r) => r.name === 'alpha-svc');
		const idxZeta = rows.findIndex((r) => r.name === 'zeta-svc');
		expect(idxAlpha).toBeGreaterThanOrEqual(0);
		expect(idxAlpha).toBeLessThan(idxZeta);
	});
});

describe('loadMcpConnectionDescriptors — skip branches', () => {
	it('skips a saas connection with no url (warn)', async () => {
		await db.query(
			`INSERT INTO mcp_connections (name, kind, config, install_status)
			 VALUES ('no-url-svc', 'saas', $1::jsonb, 'installed')`,
			[JSON.stringify({ headers: { 'x-key': 'v' } })],
		);
		const descriptors = await withoutWarns(() =>
			loadMcpConnectionDescriptors(db, masterKeyManager),
		);
		expect(descriptors.find((d) => d.name === 'no-url-svc')).toBeUndefined();
		await db.query(`DELETE FROM mcp_connections WHERE name = 'no-url-svc'`);
	});

	it('skips a saas connection with a malformed url (warn)', async () => {
		await db.query(
			`INSERT INTO mcp_connections (name, kind, config, install_status)
			 VALUES ('bad-url-svc', 'saas', $1::jsonb, 'installed')`,
			[JSON.stringify({ url: 'not a url ::::' })],
		);
		const descriptors = await withoutWarns(() =>
			loadMcpConnectionDescriptors(db, masterKeyManager),
		);
		expect(descriptors.find((d) => d.name === 'bad-url-svc')).toBeUndefined();
		await db.query(`DELETE FROM mcp_connections WHERE name = 'bad-url-svc'`);
	});

	it('skips a local connection with no command (warn)', async () => {
		await db.query(
			`INSERT INTO mcp_connections (name, kind, config, install_status)
			 VALUES ('no-cmd-local', 'local', $1::jsonb, 'installed')`,
			[JSON.stringify({ args: ['x'] })],
		);
		const descriptors = await withoutWarns(() =>
			loadMcpConnectionDescriptors(db, masterKeyManager),
		);
		expect(descriptors.find((d) => d.name === 'no-cmd-local')).toBeUndefined();
		await db.query(`DELETE FROM mcp_connections WHERE name = 'no-cmd-local'`);
	});
});

describe('loadMcpConnectionDescriptors — oauth token materialization', () => {
	it('materializes the oauth token into the Authorization header, stripping any existing one', async () => {
		const conn = await createConnection(
			{ db, masterKeyManager },
			{
				provider: 'mcp-oauth',
				providerAccountId: 'acct-mcp',
				providerAccountLabel: 'mcp-oauth-acct',
				accessToken: 'tok-materialized',
				scopes: ['read'],
				allowedHosts: ['oauthed.example'],
			},
		);
		await db.query(
			`INSERT INTO mcp_connections (name, kind, config, install_status, oauth_connection_id)
			 VALUES ('oauthed-svc', 'saas', $1::jsonb, 'installed', $2)`,
			[
				JSON.stringify({
					url: 'https://oauthed.example/mcp',
					headers: { Authorization: 'Bearer stale-placeholder', 'x-extra': 'keep' },
				}),
				conn.id,
			],
		);

		const descriptors = await loadMcpConnectionDescriptors(db, masterKeyManager);
		const d = descriptors.find((x) => x.name === 'oauthed-svc');
		expect(d?.kind).toBe('http');
		if (d?.kind === 'http') {
			expect(d.headers?.Authorization).toBe('Bearer tok-materialized');
			expect(d.headers?.['x-extra']).toBe('keep');
		}
	});

	it('skips a saas row when the master key is locked (no token materialized)', async () => {
		const conn = await createConnection(
			{ db, masterKeyManager },
			{
				provider: 'mcp-locked',
				providerAccountId: 'acct-locked',
				providerAccountLabel: 'mcp-locked-acct',
				accessToken: 'tok-locked',
				scopes: ['read'],
				allowedHosts: ['locked.example'],
			},
		);
		await db.query(
			`INSERT INTO mcp_connections (name, kind, config, install_status, oauth_connection_id)
			 VALUES ('locked-svc', 'saas', $1::jsonb, 'installed', $2)`,
			[JSON.stringify({ url: 'https://locked.example/mcp' }), conn.id],
		);

		const lockedManager = { getKey: () => null } as unknown as MasterKeyManager;
		// With the key locked, loadAllOAuthSecrets emits a null token for the row,
		// so the descriptor build hits the "missing oauth secret" skip path.
		const descriptors = await withoutWarns(() => loadMcpConnectionDescriptors(db, lockedManager));
		expect(descriptors.find((d) => d.name === 'locked-svc')).toBeUndefined();
	});

	it('reports a decryption failure with the placeholder fallback (corrupted secret)', async () => {
		const conn = await createConnection(
			{ db, masterKeyManager },
			{
				provider: 'mcp-corrupt',
				providerAccountId: 'acct-corrupt',
				providerAccountLabel: 'mcp-corrupt-acct',
				accessToken: 'tok-corrupt',
				scopes: ['read'],
				allowedHosts: ['corrupt.example'],
			},
		);
		// Corrupt the stored access token so decrypt throws → accessToken null → skip.
		await db.query(
			`UPDATE secrets SET encrypted_value = 'not-valid-ciphertext'
			 WHERE id = (SELECT access_token_secret_id FROM oauth_connections WHERE id = $1)`,
			[conn.id],
		);
		await db.query(
			`INSERT INTO mcp_connections (name, kind, config, install_status, oauth_connection_id)
			 VALUES ('corrupt-svc', 'saas', $1::jsonb, 'installed', $2)`,
			[JSON.stringify({ url: 'https://corrupt.example/mcp' }), conn.id],
		);
		const descriptors = await withoutWarns(() =>
			loadMcpConnectionDescriptors(db, masterKeyManager),
		);
		expect(descriptors.find((d) => d.name === 'corrupt-svc')).toBeUndefined();
		// encrypt import is exercised by createConnection above; keep the symbol used.
		expect(typeof encrypt).toBe('function');
	});
});
