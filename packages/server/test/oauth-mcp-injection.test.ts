import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import { loadMcpConnectionDescriptors } from '../src/services/mcp-connections';
import { createConnection } from '../src/services/oauth/connection-store';
import { safeClose } from './helpers';
import { createTestApp } from './helpers/app';

let db: PGlite;
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

describe('mcp connection descriptor with oauth_connection_id', () => {
	it('materializes the real access token in Authorization for OAuth-backed SaaS MCPs', async () => {
		// Materialize-at-descriptor-build is the deliberate trade-off: the
		// agent's --mcp-config gets the real Bearer token (visible in
		// /proc/<pid>/cmdline inside the container) rather than a placeholder
		// to be substituted at egress. Claude Code's undici-based MCP client
		// doesn't reliably go through HTTPS_PROXY for streamable-http
		// transports, so placeholder substitution silently fails and the MCP
		// tools never load. Same precedent as the AI-adapter API key carve-out
		// in agent-runner.ts:buildProviderEnv. The vault remains source of
		// truth; each run fetches and materializes a fresh value, so revoke
		// cascades on next run.
		const conn = await createConnection(
			{ db, masterKeyManager },
			{
				teamId,
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

		const descriptors = await loadMcpConnectionDescriptors(db, masterKeyManager);
		const dato = descriptors.find((d) => d.name === 'datocms');
		expect(dato).toBeTruthy();
		if (dato?.kind !== 'http') throw new Error('expected http descriptor');
		expect(dato.headers?.Authorization).toBe('Bearer real-secret-token-value');
		expect(dato.headers?.['X-Custom']).toBe('keep-me');
		expect(dato.url).toBe('https://site-api.datocms.com/mcp');
	});

	it('overrides any user-provided Authorization header when oauth_connection_id is set', async () => {
		const conn = await createConnection(
			{ db, masterKeyManager },
			{
				teamId,
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

		const descriptors = await loadMcpConnectionDescriptors(db, masterKeyManager);
		const linear = descriptors.find((d) => d.name === 'linear');
		if (linear?.kind !== 'http') throw new Error('expected http descriptor');
		expect(linear.headers?.authorization).toBeUndefined();
		expect(linear.headers?.Authorization).toBe('Bearer linear-token');
	});

	it('preserves headers verbatim when oauth_connection_id is not set', async () => {
		// Non-OAuth-backed SaaS MCPs (operator-supplied headers, possibly with
		// __HEZO_SECRET_<NAME>__ placeholders for separately-managed secrets)
		// still flow through untouched — those secrets are independent of the
		// connector OAuth lifecycle and rely on the egress proxy substitution.
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
		const descriptors = await loadMcpConnectionDescriptors(db, masterKeyManager);
		const plain = descriptors.find((d) => d.name === 'plain');
		if (plain?.kind !== 'http') throw new Error('expected http descriptor');
		expect(plain.headers?.authorization).toBe('Bearer __HEZO_SECRET_RAW_KEY__');
	});
});
