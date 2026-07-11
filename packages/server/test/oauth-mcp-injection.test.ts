import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import { loadConnectorDescriptors } from '../src/services/connectors/connections';
import { createConnection } from '../src/services/oauth/connection-store';
import { safeClose } from './helpers';
import { createTestApp } from './helpers/app';

let db: Db;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let projectId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	masterKeyManager = ctx.masterKeyManager;

	const team = await db.query<{ id: string }>(
		`INSERT INTO teams (name, slug) VALUES ('Mcp OAuth Co', 'mcp-oauth-co') RETURNING id`,
	);
	teamId = team.rows[0].id;

	const project = await db.query<{ id: string }>(
		`INSERT INTO projects (team_id, name, slug, task_prefix) VALUES ($1, 'P', 'p', 'P') RETURNING id`,
		[teamId],
	);
	projectId = project.rows[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

/** The vault secret name behind an OAuth connection's access token. */
async function oauthSecretName(connectionId: string): Promise<string> {
	const row = await db.query<{ name: string }>(
		`SELECT s.name FROM oauth_connections oc
		 JOIN secrets s ON s.id = oc.access_token_secret_id
		 WHERE oc.id = $1`,
		[connectionId],
	);
	return row.rows[0].name;
}

describe('mcp connection descriptor auth is placeholder-only (AGENTS.md red line)', () => {
	it('emits a `Bearer __HEZO_SECRET_<name>__` placeholder for OAuth-backed SaaS MCPs — never the raw token', async () => {
		// RED LINE: the descriptor (which lands in the agent's --mcp-config) must NOT
		// contain the plaintext access token. It carries only the secret's placeholder;
		// the egress proxy substitutes the real value at request time.
		const conn = await createConnection(
			{ db, masterKeyManager },
			{
				provider: 'datocms',
				providerAccountId: 'workspace-1',
				providerAccountLabel: 'Acme Workspace',
				accessToken: 'real-secret-token-value',
				scopes: ['read', 'write'],
				allowedHosts: ['site-api.datocms.com'],
			},
		);

		await db.query(
			`INSERT INTO mcp_connections (name, kind, config, oauth_connection_id, install_status)
			 VALUES ('datocms', 'saas', $1::jsonb, $2, 'installed')`,
			[
				JSON.stringify({
					url: 'https://site-api.datocms.com/mcp',
					headers: { 'X-Custom': 'keep-me' },
				}),
				conn.id,
			],
		);

		const secretName = await oauthSecretName(conn.id);
		const descriptors = await loadConnectorDescriptors(db);
		const dato = descriptors.find((d) => d.name === 'datocms');
		expect(dato).toBeTruthy();
		if (dato?.kind !== 'http') throw new Error('expected http descriptor');
		expect(dato.headers?.Authorization).toBe(`Bearer __HEZO_SECRET_${secretName}__`);
		// The plaintext token must appear nowhere in the descriptor.
		expect(JSON.stringify(dato)).not.toContain('real-secret-token-value');
		expect(dato.headers?.['X-Custom']).toBe('keep-me');
		expect(dato.url).toBe('https://site-api.datocms.com/mcp');
	});

	it('overrides any user-provided Authorization header with the OAuth placeholder', async () => {
		const conn = await createConnection(
			{ db, masterKeyManager },
			{
				provider: 'linear',
				providerAccountId: 'team-1',
				providerAccountLabel: 'Linear Team',
				accessToken: 'linear-token',
				scopes: ['read'],
				allowedHosts: ['api.linear.app'],
			},
		);

		await db.query(
			`INSERT INTO mcp_connections (name, kind, config, oauth_connection_id, install_status)
			 VALUES ('linear', 'saas', $1::jsonb, $2, 'installed')`,
			[
				JSON.stringify({
					url: 'https://api.linear.app/mcp',
					headers: { authorization: 'Bearer should-be-overridden' },
				}),
				conn.id,
			],
		);

		const secretName = await oauthSecretName(conn.id);
		const descriptors = await loadConnectorDescriptors(db);
		const linear = descriptors.find((d) => d.name === 'linear');
		if (linear?.kind !== 'http') throw new Error('expected http descriptor');
		expect(linear.headers?.authorization).toBeUndefined();
		expect(linear.headers?.Authorization).toBe(`Bearer __HEZO_SECRET_${secretName}__`);
	});

	it('emits a placeholder for an API-key connector, defaulting to Authorization: Bearer', async () => {
		// A pasted-key secret + a connector referencing it via api_key_secret_id.
		const secret = await db.query<{ id: string }>(
			`INSERT INTO secrets (name, encrypted_value, category, allowed_hosts)
			 VALUES ('MCP_TYPEFULLY_ABCD1234', 'enc', 'api_token'::secret_category, '{mcp.typefully.com}')
			 RETURNING id`,
		);
		await db.query(
			`INSERT INTO mcp_connections (name, kind, config, api_key_secret_id, activated_at, install_status)
			 VALUES ('typefully', 'saas', $1::jsonb, $2, now(), 'installed')`,
			[JSON.stringify({ url: 'https://mcp.typefully.com/mcp' }), secret.rows[0].id],
		);
		const descriptors = await loadConnectorDescriptors(db);
		const tf = descriptors.find((d) => d.name === 'typefully');
		if (tf?.kind !== 'http') throw new Error('expected http descriptor');
		expect(tf.headers?.Authorization).toBe('Bearer __HEZO_SECRET_MCP_TYPEFULLY_ABCD1234__');
	});

	it('honors a custom header + scheme override from config.apiKey', async () => {
		const secret = await db.query<{ id: string }>(
			`INSERT INTO secrets (name, encrypted_value, category, allowed_hosts)
			 VALUES ('MCP_RAWHEADER_EE11FF22', 'enc', 'api_token'::secret_category, '{raw.example.com}')
			 RETURNING id`,
		);
		await db.query(
			`INSERT INTO mcp_connections (name, kind, config, api_key_secret_id, activated_at, install_status)
			 VALUES ('rawheader', 'saas', $1::jsonb, $2, now(), 'installed')`,
			[
				JSON.stringify({
					url: 'https://raw.example.com/mcp',
					apiKey: { header: 'X-API-Key', scheme: '' },
				}),
				secret.rows[0].id,
			],
		);
		const descriptors = await loadConnectorDescriptors(db);
		const raw = descriptors.find((d) => d.name === 'rawheader');
		if (raw?.kind !== 'http') throw new Error('expected http descriptor');
		expect(raw.headers?.['X-API-Key']).toBe('__HEZO_SECRET_MCP_RAWHEADER_EE11FF22__');
		expect(raw.headers?.Authorization).toBeUndefined();
	});

	it('preserves operator-supplied placeholder headers verbatim when there is no connector-managed auth', async () => {
		await db.query(
			`INSERT INTO mcp_connections (name, kind, config, install_status)
			 VALUES ('plain', 'saas', $1::jsonb, 'installed')`,
			[
				JSON.stringify({
					url: 'https://example.com/mcp',
					headers: { authorization: 'Bearer __HEZO_SECRET_RAW_KEY__' },
				}),
			],
		);
		const descriptors = await loadConnectorDescriptors(db);
		const plain = descriptors.find((d) => d.name === 'plain');
		if (plain?.kind !== 'http') throw new Error('expected http descriptor');
		expect(plain.headers?.authorization).toBe('Bearer __HEZO_SECRET_RAW_KEY__');
	});
});
