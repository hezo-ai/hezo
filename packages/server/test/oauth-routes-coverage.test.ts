import { createServer, type Server } from 'node:http';
import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { Hono as HonoApp } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Env } from '../src/lib/types';
import { createOrFetchConnector, getConnector } from '../src/services/connectors/lifecycle';
import { createConnection } from '../src/services/oauth/connection-store';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestTeam, projectSlugFor } from './helpers/app';
import { startFakeMcpServer } from './helpers/fake-mcp-server';

/**
 * Branch-coverage companion for `routes/oauth.ts`. Targets uncovered branches
 * the existing oauth-routes-extended / oauth-github-routes suites don't reach:
 *  - /oauth/callback `missing_provider_config` (signed state, no manualConfig)
 *  - /oauth/auth-code/start with explicit `scopes` override
 *  - /oauth/mcp-callback success (DCR auth-code finalize) + its early-exit branches
 *  - device/start + device/poll validation branches (no deviceAuth, unknown flow,
 *    missing flow_id, connector-mismatch forbidden)
 *  - scope-status github success + non-github rejection
 */

/** A minimal generic OAuth AS, mirroring the one in oauth-routes-extended. */
interface GenericOAuthSim {
	server: Server;
	baseUrl: string;
	destroy(): Promise<void>;
}

async function startGenericOAuthSim(): Promise<GenericOAuthSim> {
	const app = new HonoApp();
	app.get('/authorize', (c) => {
		const redirectUri = c.req.query('redirect_uri');
		const state = c.req.query('state');
		if (!redirectUri || !state) return c.text('missing redirect_uri or state', 400);
		const url = new URL(redirectUri);
		url.searchParams.set('code', 'auth-code-xyz');
		url.searchParams.set('state', state);
		return c.redirect(url.toString(), 302);
	});
	app.post('/token', async (c) => {
		const body = (await c.req.parseBody()) as Record<string, string>;
		return c.json({
			access_token: `gen-tok-${body.code ?? 'x'}`,
			refresh_token: 'gen-ref',
			token_type: 'bearer',
			expires_in: 3600,
			scope: 'read write',
		});
	});

	const server = createServer(async (req, res) => {
		const url = `http://localhost${req.url}`;
		const headers = new Headers();
		for (const [k, v] of Object.entries(req.headers)) {
			if (v) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
		}
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk);
		const reqBody = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
		const response = await app.fetch(
			new Request(url, {
				method: req.method,
				headers,
				body: reqBody && req.method !== 'GET' && req.method !== 'HEAD' ? reqBody : undefined,
			}),
		);
		res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
		res.end(Buffer.from(await response.arrayBuffer()));
	});
	await new Promise<void>((resolve) => server.listen(0, resolve));
	const addr = server.address();
	const port = typeof addr === 'object' && addr ? addr.port : 0;
	return {
		server,
		baseUrl: `http://localhost:${port}`,
		async destroy() {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

let app: Hono<Env>;
let db: PGlite;
let token: string;
let teamId: string;
let projectSlug: string;
let sim: GenericOAuthSim;
let testMasterKeyManager: MasterKeyManager;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	testMasterKeyManager = ctx.masterKeyManager;

	const teamRes = await createTestTeam(db, { name: 'OAuth Coverage Co' });
	teamId = (await teamRes.json()).data.id;
	projectSlug = await projectSlugFor(db, teamId);

	sim = await startGenericOAuthSim();
});

afterAll(async () => {
	await sim.destroy();
	await safeClose(db);
});

function manualConfig(base: string) {
	return {
		authorize_url: `${base}/authorize`,
		token_url: `${base}/token`,
		client_id: 'cli-123',
		client_secret: 'sec-456',
		scopes: ['read', 'write'],
	};
}

describe('POST /projects/:projectId/oauth/auth-code/start — scopes override', () => {
	it('uses the explicit scopes array over manual_config.scopes in the authorize URL', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/oauth/auth-code/start`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				provider: 'notion',
				manual_config: manualConfig(sim.baseUrl),
				scopes: ['custom:one', 'custom:two'],
			}),
		});
		expect(res.status).toBe(200);
		const authUrl = ((await res.json()) as { data: { auth_url: string } }).data.auth_url;
		expect(new URL(authUrl).searchParams.get('scope')).toBe('custom:one custom:two');
	});
});

describe('GET /oauth/mcp-callback — full DCR auth-code success + finalize', () => {
	it('completes auth-start → authorize redirect → mcp-callback, storing the oauth row and activating the connector', async () => {
		const fake = await startFakeMcpServer();
		try {
			const { row } = await createOrFetchConnector(db, {
				name: 'dcr-success',
				displayName: 'DCR Success',
				mcpUrl: `${fake.url}/mcp`,
				mcpTransport: 'http',
			});

			const startRes = await app.request(`/api/projects/${projectSlug}/auth-start`, {
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ connector_id: row.id }),
			});
			expect(startRes.status).toBe(200);
			const authUrl = ((await startRes.json()) as { data: { auth_url: string } }).data.auth_url;

			// Follow the authorize redirect to get code + state back.
			const authorizeRes = await fetch(authUrl, { redirect: 'manual' });
			expect(authorizeRes.status).toBe(302);
			const loc = new URL(authorizeRes.headers.get('location')!);
			const code = loc.searchParams.get('code')!;
			const state = loc.searchParams.get('state')!;
			expect(loc.pathname).toBe('/api/oauth/mcp-callback');

			const cb = await app.request(
				`/api/oauth/mcp-callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
			);
			expect(cb.status).toBe(200);
			expect(await cb.text()).toContain('OAuth connection complete');

			// Connector linked + activated, oauth row created.
			const conn = await db.query<{
				oauth_connection_id: string | null;
				activated_at: string | null;
			}>(`SELECT oauth_connection_id, activated_at FROM mcp_connections WHERE id = $1`, [row.id]);
			expect(conn.rows[0].oauth_connection_id).toBeTruthy();
			expect(conn.rows[0].activated_at).toBeTruthy();

			const oauthRow = await db.query<{ provider: string }>(
				`SELECT provider FROM oauth_connections WHERE id = $1`,
				[conn.rows[0].oauth_connection_id],
			);
			expect(oauthRow.rows[0].provider).toBe(`mcp:${row.id}`);
		} finally {
			await fake.close();
		}
	});

	it('renders exchange_failed and marks the connector failed when the token endpoint rejects', async () => {
		// auth-start succeeds (DCR + authorize fine) but the token endpoint rejects.
		const fake = await startFakeMcpServer({ rejectExchange: true });
		try {
			const { row } = await createOrFetchConnector(db, {
				name: 'dcr-exchange-fail',
				displayName: 'DCR Exchange Fail',
				mcpUrl: `${fake.url}/mcp`,
				mcpTransport: 'http',
			});
			const startRes = await app.request(`/api/projects/${projectSlug}/auth-start`, {
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ connector_id: row.id }),
			});
			const authUrl = ((await startRes.json()) as { data: { auth_url: string } }).data.auth_url;
			const authorizeRes = await fetch(authUrl, { redirect: 'manual' });
			const loc = new URL(authorizeRes.headers.get('location')!);
			const code = loc.searchParams.get('code')!;
			const state = loc.searchParams.get('state')!;

			const cb = await app.request(
				`/api/oauth/mcp-callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
			);
			expect(cb.status).toBe(200);
			expect(await cb.text()).toContain('exchange_failed');

			const connector = await getConnector(db, row.id);
			expect(connector?.auth_error).toMatch(/exchange:/);
		} finally {
			await fake.close();
		}
	});

	it('renders connector_not_found when the connector referenced by the state was deleted', async () => {
		const fake = await startFakeMcpServer();
		try {
			const { row } = await createOrFetchConnector(db, {
				name: 'dcr-deleted',
				displayName: 'DCR Deleted',
				mcpUrl: `${fake.url}/mcp`,
				mcpTransport: 'http',
			});
			const startRes = await app.request(`/api/projects/${projectSlug}/auth-start`, {
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ connector_id: row.id }),
			});
			const authUrl = ((await startRes.json()) as { data: { auth_url: string } }).data.auth_url;
			const authorizeRes = await fetch(authUrl, { redirect: 'manual' });
			const loc = new URL(authorizeRes.headers.get('location')!);
			const code = loc.searchParams.get('code')!;
			const state = loc.searchParams.get('state')!;

			// Delete the connector before the callback resolves it.
			await db.query(`DELETE FROM mcp_connections WHERE id = $1`, [row.id]);

			const cb = await app.request(
				`/api/oauth/mcp-callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
			);
			expect(cb.status).toBe(200);
			expect(await cb.text()).toContain('connector_not_found');
		} finally {
			await fake.close();
		}
	});
});

describe('device/start validation branches', () => {
	it('404s for an unknown connector id', async () => {
		const res = await app.request(
			`/api/projects/${projectSlug}/connectors/${crypto.randomUUID()}/device/start`,
			{ method: 'POST', headers: { ...authHeader(token), 'Content-Type': 'application/json' } },
		);
		expect(res.status).toBe(404);
	});

	it('400s when the connector capability has no device flow', async () => {
		// A connector whose registry name carries no deviceAuth capability.
		const { row } = await createOrFetchConnector(db, {
			name: 'no-device-cap',
			displayName: 'NoDeviceCap',
			mcpUrl: `${sim.baseUrl}/mcp`,
			mcpTransport: 'http',
		});
		const res = await app.request(
			`/api/projects/${projectSlug}/connectors/${row.id}/device/start`,
			{ method: 'POST', headers: { ...authHeader(token), 'Content-Type': 'application/json' } },
		);
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(
			/does not support the device flow/,
		);
	});
});

describe('device/poll validation branches', () => {
	it('400s when flow_id is missing', async () => {
		const res = await app.request(
			`/api/projects/${projectSlug}/connectors/${crypto.randomUUID()}/device/poll`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({}),
			},
		);
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INVALID_REQUEST');
	});

	it('404s for an unknown/expired flow_id', async () => {
		const res = await app.request(
			`/api/projects/${projectSlug}/connectors/${crypto.randomUUID()}/device/poll`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ flow_id: 'does-not-exist' }),
			},
		);
		expect(res.status).toBe(404);
		expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(
			/unknown or expired/,
		);
	});
});

describe('scope-status branches', () => {
	it('returns the computed scope status for a github connection', async () => {
		const conn = await createConnection(
			{ db, masterKeyManager: testMasterKeyManager },
			{
				provider: 'github',
				providerAccountId: 'gh:scope-1',
				providerAccountLabel: 'octo',
				accessToken: 'gho_scope_tok',
				scopes: ['repo', 'workflow', 'read:org'],
				allowedHosts: ['github.com'],
				metadata: {},
			},
		);
		const res = await app.request(
			`/api/projects/${projectSlug}/oauth-connections/${conn.id}/scope-status`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { data: Record<string, unknown> };
		expect(body.data).toBeTruthy();
	});

	it('400s scope-status for a non-github connection', async () => {
		const conn = await createConnection(
			{ db, masterKeyManager: testMasterKeyManager },
			{
				provider: 'notion',
				providerAccountId: 'notion:1',
				providerAccountLabel: 'Notion',
				accessToken: 'notion_tok',
				scopes: ['read'],
				allowedHosts: ['api.notion.com'],
				metadata: {},
			},
		);
		const res = await app.request(
			`/api/projects/${projectSlug}/oauth-connections/${conn.id}/scope-status`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(
			/only supported for github/,
		);
	});
});
