import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Hono } from 'hono';
import { Hono as HonoApp } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { createOrFetchConnector, getConnector } from '../src/services/connectors/lifecycle';
import { createConnection } from '../src/services/oauth/connection-store';
import { type ManualOAuthConfig, signState } from '../src/services/oauth/state';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestTeam,
	mintAgentToken,
	projectSlugFor,
} from './helpers/app';
import { startFakeMcpServer } from './helpers/fake-mcp-server';

/**
 * Line/branch coverage for the auth-code half of `routes/oauth.ts`:
 * /oauth/callback error mappings and success side effects, auth-code/start
 * validation + discovery branches, the connector auth-start DCR walk (project
 * and instance-admin surfaces), /oauth/mcp-callback error branches, and the
 * oauth-connections list/scope-status/delete routes. All providers are local
 * in-process HTTP simulators — no real network.
 */

interface LocalSim {
	baseUrl: string;
	destroy(): Promise<void>;
}

/** Generic OAuth AS: auto-approving authorize, token issue/reject, AS metadata. */
async function startGenericAuthSim(): Promise<LocalSim> {
	const app = new HonoApp();
	app.get('/authorize', (c) => {
		const redirectUri = c.req.query('redirect_uri');
		const state = c.req.query('state');
		if (!redirectUri || !state) return c.text('missing redirect_uri or state', 400);
		const url = new URL(redirectUri);
		url.searchParams.set('code', 'code-abc');
		url.searchParams.set('state', state);
		return c.redirect(url.toString(), 302);
	});
	app.post('/token', async (c) => {
		const body = (await c.req.parseBody()) as Record<string, string>;
		return c.json({
			access_token: `tok-${body.code ?? 'x'}`,
			refresh_token: 'refresh-abc',
			token_type: 'bearer',
			expires_in: 3600,
			scope: 'read write',
		});
	});
	app.post('/token-fail', (c) => c.json({ error: 'invalid_grant' }, 400));
	// Token response with no `scope` — callers must fall back to config scopes.
	app.post('/token-noscope', (c) => c.json({ access_token: 'tok-noscope', token_type: 'bearer' }));
	// AS metadata so `discoverMetadata(server_url)` succeeds in spec mode.
	app.get('/.well-known/oauth-authorization-server', (c) =>
		c.json({
			issuer: 'local',
			authorization_endpoint: 'http://localhost/authorize',
			token_endpoint: 'http://localhost/token',
		}),
	);
	return serveHono(app);
}

async function serveHono(app: HonoApp): Promise<LocalSim> {
	const server: Server = createServer(async (req, res) => {
		const headers = new Headers();
		for (const [k, v] of Object.entries(req.headers)) {
			if (v) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
		}
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
		const response = await app.fetch(
			new Request(`http://localhost${req.url}`, {
				method: req.method,
				headers,
				body: body && req.method !== 'GET' && req.method !== 'HEAD' ? body : undefined,
			}),
		);
		res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
		res.end(Buffer.from(await response.arrayBuffer()));
	});
	await new Promise<void>((resolve) => server.listen(0, resolve));
	const addr = server.address();
	const port = typeof addr === 'object' && addr ? addr.port : 0;
	return {
		baseUrl: `http://localhost:${port}`,
		destroy: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

/** An origin that 404s everything: no PRM, no AS metadata. */
async function startBareSim(): Promise<LocalSim> {
	const server = createServer((_req, res) => {
		res.statusCode = 404;
		res.end('not found');
	});
	await new Promise<void>((resolve) => server.listen(0, resolve));
	const addr = server.address();
	const port = typeof addr === 'object' && addr ? addr.port : 0;
	return {
		baseUrl: `http://localhost:${port}`,
		destroy: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

let app: Hono<Env>;
let db: Db;
let token: string;
let teamId: string;
let projectSlug: string;
let masterKeyManager: MasterKeyManager;
let sim: LocalSim;
let bare: LocalSim;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const teamRes = await createTestTeam(db, { name: 'AuthCode Branch Co' });
	teamId = (await teamRes.json()).data.id;
	projectSlug = await projectSlugFor(db, teamId);

	sim = await startGenericAuthSim();
	bare = await startBareSim();
});

afterAll(async () => {
	await sim.destroy();
	await bare.destroy();
	await safeClose(db);
});

function manualConfig(overrides: Partial<ManualOAuthConfig> = {}): ManualOAuthConfig {
	return {
		authorize_url: `${sim.baseUrl}/authorize`,
		token_url: `${sim.baseUrl}/token`,
		client_id: 'client-1',
		client_secret: 'secret-1',
		scopes: ['base:scope'],
		...overrides,
	};
}

async function startAuthCode(body: Record<string, unknown>): Promise<Response> {
	return app.request(`/api/projects/${projectSlug}/oauth/auth-code/start`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
}

describe('GET /oauth/callback error branches', () => {
	it('renders the provider error code when the provider redirects with ?error=', async () => {
		const res = await app.request('/api/oauth/callback?error=access_denied');
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain('OAuth failed');
		expect(html).toContain('access_denied');
	});

	it('renders missing_code_or_state when code or state is absent', async () => {
		const res = await app.request('/api/oauth/callback?code=only-code');
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('missing_code_or_state');
	});

	it('renders invalid_state for a garbage state token', async () => {
		const res = await app.request('/api/oauth/callback?code=c&state=not.a.real-state');
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('invalid_state');
	});

	it('renders missing_provider_config for a signed state without manualConfig', async () => {
		const { state } = await signState(masterKeyManager, {
			teamId,
			projectId: null,
			provider: 'acme',
			redirectUri: 'http://localhost/api/oauth/callback',
			returnTo: '/',
		});
		const res = await app.request(`/api/oauth/callback?code=c&state=${encodeURIComponent(state)}`);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('missing_provider_config');
	});

	it('renders exchange_failed when the token endpoint rejects the code', async () => {
		const { state } = await signState(masterKeyManager, {
			teamId,
			projectId: null,
			provider: 'acme',
			redirectUri: 'http://localhost/api/oauth/callback',
			returnTo: '/',
			manualConfig: manualConfig({ token_url: `${sim.baseUrl}/token-fail` }),
		});
		const res = await app.request(`/api/oauth/callback?code=c&state=${encodeURIComponent(state)}`);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('exchange_failed');
		// No connection row was created for the failed exchange.
		const rows = await db.query(`SELECT id FROM oauth_connections WHERE provider = 'acme'`);
		expect(rows.rows.length).toBe(0);
	});
});

describe('auth-code/start → authorize → /oauth/callback success', () => {
	it('links the resulting connection to the named mcp_connection and skips malformed resource hosts', async () => {
		const { row: connector } = await createOrFetchConnector(db, {
			name: 'authcode-linked',
			displayName: 'AuthCode Linked',
			mcpUrl: `${sim.baseUrl}/mcp`,
			mcpTransport: 'http',
		});

		const startRes = await startAuthCode({
			provider: 'linky',
			manual_config: manualConfig(),
			// Malformed on purpose: inferAllowedHosts must skip it, not blow up.
			server_url: 'not a valid url',
			return_to: '/projects/somewhere',
			mcp_connection_id: connector.id,
			mcp_connection_name: 'Linky Conn',
		});
		expect(startRes.status).toBe(200);
		const authUrl = ((await startRes.json()) as { data: { auth_url: string } }).data.auth_url;
		expect(new URL(authUrl).searchParams.get('resource')).toBe('not a valid url');

		const redirect = await fetch(authUrl, { redirect: 'manual' });
		expect(redirect.status).toBe(302);
		const loc = new URL(redirect.headers.get('location')!);
		expect(loc.pathname).toBe('/api/oauth/callback');

		const cb = await app.request(`${loc.pathname}?${loc.searchParams.toString()}`);
		expect(cb.status).toBe(200);
		expect(await cb.text()).toContain('OAuth connection complete');

		const conn = await db.query<{ id: string; provider_account_label: string; scopes: string[] }>(
			`SELECT id, provider_account_label, scopes FROM oauth_connections WHERE provider = 'linky'`,
		);
		expect(conn.rows.length).toBe(1);
		expect(conn.rows[0].provider_account_label).toBe('Linky Conn');
		// Scopes come from the token response's `scope`, not the config default.
		expect(conn.rows[0].scopes).toEqual(['read', 'write']);

		const linked = await db.query<{ oauth_connection_id: string | null }>(
			`SELECT oauth_connection_id FROM mcp_connections WHERE id = $1`,
			[connector.id],
		);
		expect(linked.rows[0].oauth_connection_id).toBe(conn.rows[0].id);

		// Malformed resource URL was skipped; only the token host was inferred.
		const secret = await db.query<{ allowed_hosts: string[] }>(
			`SELECT s.allowed_hosts FROM oauth_connections oc
			 JOIN secrets s ON s.id = oc.access_token_secret_id WHERE oc.id = $1`,
			[conn.rows[0].id],
		);
		expect(secret.rows[0].allowed_hosts).toEqual([new URL(sim.baseUrl).host]);
	});

	it('falls back to the configured scopes when the token response carries none', async () => {
		const { state } = await signState(masterKeyManager, {
			teamId,
			projectId: null,
			provider: 'noscope',
			redirectUri: 'http://localhost/api/oauth/callback',
			returnTo: '/',
			manualConfig: manualConfig({
				token_url: `${sim.baseUrl}/token-noscope`,
				scopes: ['cfg:scope'],
			}),
		});
		const cb = await app.request(`/api/oauth/callback?code=c1&state=${encodeURIComponent(state)}`);
		expect(cb.status).toBe(200);
		expect(await cb.text()).toContain('OAuth connection complete');
		const conn = await db.query<{ scopes: string[] }>(
			`SELECT scopes FROM oauth_connections WHERE provider = 'noscope'`,
		);
		expect(conn.rows[0].scopes).toEqual(['cfg:scope']);
	});

	it('completes without an mcp_connection_id and infers hosts from resource + token urls', async () => {
		const startRes = await startAuthCode({
			provider: 'plain',
			manual_config: manualConfig(),
			server_url: `${sim.baseUrl}/resource`,
		});
		expect(startRes.status).toBe(200);
		const authUrl = ((await startRes.json()) as { data: { auth_url: string } }).data.auth_url;
		const redirect = await fetch(authUrl, { redirect: 'manual' });
		const loc = new URL(redirect.headers.get('location')!);
		const cb = await app.request(`${loc.pathname}?${loc.searchParams.toString()}`);
		expect(cb.status).toBe(200);
		expect(await cb.text()).toContain('OAuth connection complete');

		const conn = await db.query<{ id: string; expires_at: Date | null }>(
			`SELECT id, expires_at FROM oauth_connections WHERE provider = 'plain'`,
		);
		expect(conn.rows.length).toBe(1);
		expect(conn.rows[0].expires_at).toBeTruthy();
	});

	it('persists the refresh material (token_url + client_id) on the connection metadata', async () => {
		// The generic host-side refresh reads both off metadata and throws before any
		// network call if either is missing, which would leave the connection stuck on
		// its first access token forever — silently, since the failure is swallowed.
		const startRes = await startAuthCode({
			provider: 'refreshable',
			manual_config: manualConfig(),
			server_url: `${sim.baseUrl}/resource`,
		});
		const authUrl = ((await startRes.json()) as { data: { auth_url: string } }).data.auth_url;
		const redirect = await fetch(authUrl, { redirect: 'manual' });
		const loc = new URL(redirect.headers.get('location')!);
		const cb = await app.request(`${loc.pathname}?${loc.searchParams.toString()}`);
		expect(cb.status).toBe(200);

		const conn = await db.query<{ metadata: Record<string, unknown> }>(
			`SELECT metadata FROM oauth_connections WHERE provider = 'refreshable'`,
		);
		expect(conn.rows[0].metadata.client_id).toBe('client-1');
		expect(conn.rows[0].metadata.token_url).toBe(`${sim.baseUrl}/token`);
	});
});

describe('POST /projects/:projectId/oauth/auth-code/start validation', () => {
	it('400s when provider is missing', async () => {
		const res = await startAuthCode({ manual_config: manualConfig() });
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(
			/provider is required/,
		);
	});

	it('400s when neither server_url nor manual_config is provided', async () => {
		const res = await startAuthCode({ provider: 'x' });
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(
			/server_url .*or manual_config/,
		);
	});

	it('503s OAUTH_DISCOVERY_FAILED when spec discovery finds no metadata', async () => {
		const res = await startAuthCode({ provider: 'x', server_url: `${bare.baseUrl}/mcp` });
		expect(res.status).toBe(503);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
			'OAUTH_DISCOVERY_FAILED',
		);
	});

	it('400s OAUTH_MANUAL_CONFIG_REQUIRED when discovery succeeds but no client_id is supplied', async () => {
		const res = await startAuthCode({ provider: 'x', server_url: `${sim.baseUrl}/mcp` });
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
			'OAUTH_MANUAL_CONFIG_REQUIRED',
		);
	});
});

describe('POST /projects/:projectId/auth-start (connector DCR walk)', () => {
	async function authStart(connectorId?: string): Promise<Response> {
		return app.request(`/api/projects/${projectSlug}/auth-start`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify(connectorId ? { connector_id: connectorId } : {}),
		});
	}

	it('400s when connector_id is missing', async () => {
		const res = await authStart();
		expect(res.status).toBe(400);
	});

	it('404s for an unknown connector', async () => {
		const res = await authStart(randomUUID());
		expect(res.status).toBe(404);
	});

	it('restores a revoked connector in place and re-authorizes instead of erroring', async () => {
		const fake = await startFakeMcpServer();
		try {
			const { row } = await createOrFetchConnector(db, {
				name: 'revoked-conn',
				displayName: 'Revoked',
				mcpUrl: `${fake.url}/mcp`,
				mcpTransport: 'http',
			});
			await db.query(`UPDATE mcp_connections SET revoked_at = now() WHERE id = $1`, [row.id]);
			const res = await authStart(row.id);
			// No CONNECTOR_REVOKED error — the row is restored and the DCR walk yields
			// an authorize URL (a fresh reconnect).
			expect(res.status).toBe(200);
			const authUrl = ((await res.json()) as { data: { auth_url: string } }).data.auth_url;
			expect(authUrl).toContain('/authorize?');
			// The connector is un-revoked, ready to re-authorize.
			const after = await getConnector(db, row.id);
			expect(after?.revoked_at).toBeNull();
		} finally {
			await fake.close();
		}
	});

	it('400s for a non-saas connector', async () => {
		const local = await db.query<{ id: string }>(
			`INSERT INTO mcp_connections (name, display_name, kind, config)
			 VALUES ('local-kind-conn', 'Local Kind', 'local'::mcp_connection_kind, '{}'::jsonb)
			 RETURNING id`,
		);
		const res = await authStart(local.rows[0].id);
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(
			/only applies to saas/,
		);
	});

	it('400s for a saas connector with no MCP server url', async () => {
		const noUrl = await db.query<{ id: string }>(
			`INSERT INTO mcp_connections (name, display_name, kind, config)
			 VALUES ('no-url-conn', 'No Url', 'saas'::mcp_connection_kind, '{}'::jsonb)
			 RETURNING id`,
		);
		const res = await authStart(noUrl.rows[0].id);
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(
			/no MCP server url/,
		);
	});

	it('resolves a PRM-less MCP server to { auth_url: null } without failing the connector (project surface)', async () => {
		const { row } = await createOrFetchConnector(db, {
			name: 'no-prm-conn',
			displayName: 'No PRM',
			mcpUrl: `${bare.baseUrl}/mcp`,
			mcpTransport: 'http',
		});
		const res = await authStart(row.id);
		// A connector added on the project page may be public / header-authenticated:
		// missing PRM is the normal "use API key" shape, not a discovery failure.
		expect(res.status).toBe(200);
		const body = (await res.json()) as { data: { auth_url: string | null; reason?: string } };
		expect(body.data.auth_url).toBeNull();
		const after = await getConnector(db, row.id);
		expect(after?.auth_error).toBeNull();
	});

	it('400s OAUTH_DCR_UNSUPPORTED when the AS advertises no registration_endpoint', async () => {
		const fake = await startFakeMcpServer({ noRegistrationEndpoint: true });
		try {
			const { row } = await createOrFetchConnector(db, {
				name: 'no-dcr-conn',
				displayName: 'No DCR',
				mcpUrl: `${fake.url}/mcp`,
				mcpTransport: 'http',
			});
			const res = await authStart(row.id);
			expect(res.status).toBe(400);
			expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
				'OAUTH_DCR_UNSUPPORTED',
			);
			const after = await getConnector(db, row.id);
			expect(after?.auth_error).toMatch(/registration_endpoint/);
		} finally {
			await fake.close();
		}
	});

	it('503s OAUTH_DCR_FAILED when the registration endpoint rejects', async () => {
		const fake = await startFakeMcpServer({ rejectDcr: true });
		try {
			const { row } = await createOrFetchConnector(db, {
				name: 'dcr-reject-conn',
				displayName: 'DCR Reject',
				mcpUrl: `${fake.url}/mcp`,
				mcpTransport: 'http',
			});
			const res = await authStart(row.id);
			expect(res.status).toBe(503);
			expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
				'OAUTH_DCR_FAILED',
			);
			const after = await getConnector(db, row.id);
			expect(after?.auth_error).toMatch(/^DCR:/);
		} finally {
			await fake.close();
		}
	});

	it('persists the DCR result on first auth-start and reuses it on the second', async () => {
		const fake = await startFakeMcpServer();
		try {
			const { row } = await createOrFetchConnector(db, {
				name: 'dcr-cache-conn',
				displayName: 'DCR Cache',
				mcpUrl: `${fake.url}/mcp`,
				mcpTransport: 'http',
			});
			const first = await authStart(row.id);
			expect(first.status).toBe(200);
			const firstUrl = ((await first.json()) as { data: { auth_url: string } }).data.auth_url;
			const firstClientId = new URL(firstUrl).searchParams.get('client_id');
			expect(firstClientId).toBe(fake.lastClientId());

			const after = await getConnector(db, row.id);
			const dcr = (after?.config as { dcr?: { client_id: string } }).dcr;
			expect(dcr?.client_id).toBe(firstClientId);

			// Second start reuses the cached DCR registration — same client_id.
			const second = await authStart(row.id);
			expect(second.status).toBe(200);
			const secondUrl = ((await second.json()) as { data: { auth_url: string } }).data.auth_url;
			expect(new URL(secondUrl).searchParams.get('client_id')).toBe(firstClientId);
		} finally {
			await fake.close();
		}
	});

	it('re-registers a fresh DCR client when the callback origin changed (stale redirect_uri)', async () => {
		const fake = await startFakeMcpServer();
		try {
			const { row } = await createOrFetchConnector(db, {
				name: 'dcr-origin-change-conn',
				displayName: 'DCR Origin Change',
				mcpUrl: `${fake.url}/mcp`,
				mcpTransport: 'http',
			});

			// First connect resolves the callback over http (no x-forwarded-proto),
			// so the DCR client is registered against an http:// redirect_uri.
			const first = await authStart(row.id);
			expect(first.status).toBe(200);
			const firstUrl = new URL(
				((await first.json()) as { data: { auth_url: string } }).data.auth_url,
			);
			const firstClientId = firstUrl.searchParams.get('client_id');
			const firstRedirect = firstUrl.searchParams.get('redirect_uri');
			expect(firstRedirect).toMatch(/^http:\/\//);

			// Second connect arrives over https (the reverse proxy now forwards
			// x-forwarded-proto: https). The cached client is bound to the http
			// callback, so reusing it would send the AS a redirect_uri it never
			// registered — instead a fresh client is minted for the https origin.
			const second = await app.request(`/api/projects/${projectSlug}/auth-start`, {
				method: 'POST',
				headers: {
					...authHeader(token),
					'Content-Type': 'application/json',
					'x-forwarded-proto': 'https',
				},
				body: JSON.stringify({ connector_id: row.id }),
			});
			expect(second.status).toBe(200);
			const secondUrl = new URL(
				((await second.json()) as { data: { auth_url: string } }).data.auth_url,
			);
			const secondRedirect = secondUrl.searchParams.get('redirect_uri');
			expect(secondRedirect).toMatch(/^https:\/\//);
			expect(secondUrl.searchParams.get('client_id')).not.toBe(firstClientId);

			// The re-registered client accepts the https redirect_uri: the fake AS
			// 302s from /authorize instead of rejecting the redirect_uri (which is
			// exactly what the stale-cache reuse would have triggered).
			const authorize = await fetch(secondUrl.toString(), { redirect: 'manual' });
			expect(authorize.status).toBe(302);

			// The cache now records the origin the live client was registered against.
			const after = await getConnector(db, row.id);
			const cachedDcr = (after?.config as { dcr?: { redirect_uri?: string; client_id?: string } })
				.dcr;
			expect(cachedDcr?.redirect_uri).toBe(secondRedirect);
			expect(cachedDcr?.client_id).toBe(secondUrl.searchParams.get('client_id'));
		} finally {
			await fake.close();
		}
	});
});

describe('POST /connectors/:id/auth-start (instance-admin surface)', () => {
	it('403s for a non-admin (agent) caller', async () => {
		const agent = await db.query<{ id: string }>(
			`SELECT id FROM members WHERE team_id = $1 AND member_type = 'agent' LIMIT 1`,
			[teamId],
		);
		const minted = await mintAgentToken(db, masterKeyManager, agent.rows[0].id, teamId);
		const res = await app.request(`/api/connectors/${randomUUID()}/auth-start`, {
			method: 'POST',
			headers: { ...authHeader(minted.token), 'Content-Type': 'application/json' },
		});
		expect(res.status).toBe(403);
	});

	it('resolves a PRM-less MCP server to { auth_url: null } without failing the connector', async () => {
		const { row } = await createOrFetchConnector(db, {
			name: 'admin-no-oauth-conn',
			displayName: 'Admin NoOAuth',
			mcpUrl: `${bare.baseUrl}/mcp`,
			mcpTransport: 'http',
		});
		const res = await app.request(`/api/connectors/${row.id}/auth-start`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { data: { auth_url: string | null; reason?: string } };
		expect(body.data.auth_url).toBeNull();
		expect(body.data.reason).toMatch(/Could not discover OAuth endpoints/);
		const after = await getConnector(db, row.id);
		expect(after?.auth_error).toBeNull();
	});

	it('returns an auth_url for an OAuth-capable MCP server', async () => {
		const fake = await startFakeMcpServer();
		try {
			const { row } = await createOrFetchConnector(db, {
				name: 'admin-oauth-conn',
				displayName: 'Admin OAuth',
				mcpUrl: `${fake.url}/mcp`,
				mcpTransport: 'http',
			});
			const res = await app.request(`/api/connectors/${row.id}/auth-start`, {
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as { data: { auth_url: string | null } };
			expect(body.data.auth_url).toContain('/authorize?');
		} finally {
			await fake.close();
		}
	});
});

describe('GET /oauth/mcp-callback error branches', () => {
	it('renders the provider error code on ?error=', async () => {
		const res = await app.request('/api/oauth/mcp-callback?error=consent_denied');
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('consent_denied');
	});

	it('renders missing_code_or_state when parameters are absent', async () => {
		const res = await app.request('/api/oauth/mcp-callback?state=s-only');
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('missing_code_or_state');
	});

	it('renders invalid_state for a garbage state', async () => {
		const res = await app.request('/api/oauth/mcp-callback?code=c&state=zzz');
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('invalid_state');
	});

	it('renders missing_connector_id when the state has no mcpConnectionId', async () => {
		const { state } = await signState(masterKeyManager, {
			teamId,
			projectId: null,
			provider: 'mcp:none',
			redirectUri: 'http://localhost/api/oauth/mcp-callback',
			returnTo: '/',
			manualConfig: manualConfig(),
		});
		const res = await app.request(
			`/api/oauth/mcp-callback?code=c&state=${encodeURIComponent(state)}`,
		);
		expect(await res.text()).toContain('missing_connector_id');
	});

	it('renders missing_provider_config when the state has no manualConfig', async () => {
		const { state } = await signState(masterKeyManager, {
			teamId,
			projectId: null,
			provider: 'mcp:x',
			redirectUri: 'http://localhost/api/oauth/mcp-callback',
			returnTo: '/',
			mcpConnectionId: randomUUID(),
		});
		const res = await app.request(
			`/api/oauth/mcp-callback?code=c&state=${encodeURIComponent(state)}`,
		);
		expect(await res.text()).toContain('missing_provider_config');
	});

	it('renders connector_not_found when the referenced connector does not exist', async () => {
		const { state } = await signState(masterKeyManager, {
			teamId,
			projectId: null,
			provider: 'mcp:gone',
			redirectUri: 'http://localhost/api/oauth/mcp-callback',
			returnTo: '/',
			mcpConnectionId: randomUUID(),
			manualConfig: manualConfig(),
		});
		const res = await app.request(
			`/api/oauth/mcp-callback?code=c&state=${encodeURIComponent(state)}`,
		);
		expect(await res.text()).toContain('connector_not_found');
	});

	it('renders exchange_failed and marks the connector failed on token rejection', async () => {
		const { row } = await createOrFetchConnector(db, {
			name: 'mcp-cb-exchange-fail',
			displayName: 'CB Exchange Fail',
			mcpUrl: `${sim.baseUrl}/mcp`,
			mcpTransport: 'http',
		});
		const { state } = await signState(masterKeyManager, {
			teamId,
			projectId: null,
			provider: `mcp:${row.id}`,
			redirectUri: 'http://localhost/api/oauth/mcp-callback',
			returnTo: '/',
			mcpConnectionId: row.id,
			manualConfig: manualConfig({ token_url: `${sim.baseUrl}/token-fail` }),
		});
		const res = await app.request(
			`/api/oauth/mcp-callback?code=c&state=${encodeURIComponent(state)}`,
		);
		expect(await res.text()).toContain('exchange_failed');
		const after = await getConnector(db, row.id);
		expect(after?.auth_error).toMatch(/^exchange:/);
	});

	it('falls back to the configured scopes when the token response carries none', async () => {
		const { row } = await createOrFetchConnector(db, {
			name: 'mcp-cb-noscope',
			displayName: 'CB NoScope',
			mcpUrl: `${sim.baseUrl}/mcp`,
			mcpTransport: 'http',
		});
		const { state } = await signState(masterKeyManager, {
			teamId,
			projectId: null,
			provider: `mcp:${row.id}`,
			redirectUri: 'http://localhost/api/oauth/mcp-callback',
			returnTo: '/',
			mcpConnectionId: row.id,
			manualConfig: manualConfig({
				token_url: `${sim.baseUrl}/token-noscope`,
				scopes: ['cfg:scope'],
			}),
		});
		const res = await app.request(
			`/api/oauth/mcp-callback?code=c2&state=${encodeURIComponent(state)}`,
		);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('OAuth connection complete');
		const after = await getConnector(db, row.id);
		expect(after?.activated_at).toBeTruthy();
		const conn = await db.query<{ scopes: string[] }>(
			`SELECT scopes FROM oauth_connections WHERE id = $1`,
			[after?.oauth_connection_id],
		);
		expect(conn.rows[0].scopes).toEqual(['cfg:scope']);
	});

	it('finalizes a full DCR auth-code flow: connection stored, connector active, metadata linked', async () => {
		const fake = await startFakeMcpServer();
		try {
			const { row } = await createOrFetchConnector(db, {
				name: 'mcp-cb-success',
				displayName: 'CB Success',
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
			const redirect = await fetch(authUrl, { redirect: 'manual' });
			expect(redirect.status).toBe(302);
			const loc = new URL(redirect.headers.get('location')!);
			expect(loc.pathname).toBe('/api/oauth/mcp-callback');

			const cb = await app.request(`${loc.pathname}?${loc.searchParams.toString()}`);
			expect(cb.status).toBe(200);
			expect(await cb.text()).toContain('OAuth connection complete');

			const after = await getConnector(db, row.id);
			expect(after?.oauth_connection_id).toBeTruthy();
			expect(after?.activated_at).toBeTruthy();

			const conn = await db.query<{ metadata: Record<string, unknown>; scopes: string[] }>(
				`SELECT metadata, scopes FROM oauth_connections WHERE id = $1`,
				[after?.oauth_connection_id],
			);
			expect(conn.rows[0].metadata.connector_id).toBe(row.id);
			expect(conn.rows[0].scopes).toEqual(['read', 'write']);

			const secret = await db.query<{ allowed_hosts: string[] }>(
				`SELECT s.allowed_hosts FROM oauth_connections oc
				 JOIN secrets s ON s.id = oc.access_token_secret_id WHERE oc.id = $1`,
				[after?.oauth_connection_id],
			);
			expect(secret.rows[0].allowed_hosts).toContain(new URL(fake.url).host);
		} finally {
			await fake.close();
		}
	});
});

describe('oauth-connections list / scope-status / delete routes', () => {
	it('lists connections with mapped fields and no token material', async () => {
		const created = await createConnection(
			{ db, masterKeyManager },
			{
				provider: 'listable',
				providerAccountId: 'list:1',
				providerAccountLabel: 'Listable',
				accessToken: 'list-secret-token',
				scopes: ['s1'],
				allowedHosts: ['list.test'],
				metadata: { note: 'hi' },
			},
		);
		const res = await app.request(`/api/projects/${projectSlug}/oauth-connections`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { data: Array<Record<string, unknown>> };
		const mine = body.data.find((c) => c.id === created.id);
		expect(mine).toMatchObject({
			provider: 'listable',
			provider_account_id: 'list:1',
			provider_account_label: 'Listable',
			scopes: ['s1'],
			metadata: { note: 'hi' },
		});
		expect(JSON.stringify(body.data)).not.toContain('list-secret-token');
	});

	it('404s scope-status for an unknown connection id', async () => {
		const res = await app.request(
			`/api/projects/${projectSlug}/oauth-connections/${randomUUID()}/scope-status`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
	});

	it('400s scope-status for a non-github connection and 200s for github', async () => {
		const notGh = await createConnection(
			{ db, masterKeyManager },
			{
				provider: 'gitlab',
				providerAccountId: 'gl:1',
				providerAccountLabel: 'GL',
				accessToken: 'gl-tok',
				scopes: ['api'],
				allowedHosts: ['gitlab.test'],
			},
		);
		const bad = await app.request(
			`/api/projects/${projectSlug}/oauth-connections/${notGh.id}/scope-status`,
			{ headers: authHeader(token) },
		);
		expect(bad.status).toBe(400);

		const gh = await createConnection(
			{ db, masterKeyManager },
			{
				provider: 'github',
				providerAccountId: 'gh:scope',
				providerAccountLabel: 'GH',
				accessToken: 'gh-tok',
				scopes: ['repo', 'workflow'],
				allowedHosts: ['github.com'],
			},
		);
		const good = await app.request(
			`/api/projects/${projectSlug}/oauth-connections/${gh.id}/scope-status`,
			{ headers: authHeader(token) },
		);
		expect(good.status).toBe(200);
		expect(((await good.json()) as { data: unknown }).data).toBeTruthy();
	});

	it('404s delete for an unknown connection and deletes one the project owns', async () => {
		const missing = await app.request(
			`/api/projects/${projectSlug}/oauth-connections/${randomUUID()}`,
			{ method: 'DELETE', headers: authHeader(token) },
		);
		expect(missing.status).toBe(404);

		const projectId = (
			await db.query<{ id: string }>(`SELECT id FROM projects WHERE slug = $1`, [projectSlug])
		).rows[0].id;
		const created = await createConnection(
			{ db, masterKeyManager },
			{
				provider: 'deletable',
				providerAccountId: 'delr:1',
				providerAccountLabel: 'Deletable',
				accessToken: 'del-tok',
				scopes: [],
				allowedHosts: ['del.test'],
				projectId,
			},
		);
		const del = await app.request(`/api/projects/${projectSlug}/oauth-connections/${created.id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(del.status).toBe(200);
		expect(((await del.json()) as { data: { deleted: boolean } }).data.deleted).toBe(true);
		const gone = await db.query(`SELECT id FROM oauth_connections WHERE id = $1`, [created.id]);
		expect(gone.rows.length).toBe(0);
	});

	it('404s delete of a GLOBAL connection from a project surface', async () => {
		// A project can SEE a global connection - it may link a repo through one -
		// but deleting it runs `deleteConnection`, whose
		// `UPDATE repos SET oauth_connection_id = NULL` carries no project filter.
		// Allowing this let one project strip git auth from every other project's
		// repos. Global connections are disconnected from the instance surface.
		const global = await createConnection(
			{ db, masterKeyManager },
			{
				provider: 'globaldeletable',
				providerAccountId: 'delr:global',
				providerAccountLabel: 'Global Deletable',
				accessToken: 'del-tok-global',
				scopes: [],
				allowedHosts: ['del.test'],
			},
		);
		const del = await app.request(`/api/projects/${projectSlug}/oauth-connections/${global.id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(del.status).toBe(404);
		const still = await db.query(`SELECT id FROM oauth_connections WHERE id = $1`, [global.id]);
		expect(still.rows.length).toBe(1);
	});
});
