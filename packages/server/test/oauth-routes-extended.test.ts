import { createServer, type Server } from 'node:http';
import type { Hono } from 'hono';
import { Hono as HonoApp } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { createOrFetchConnector, getConnector } from '../src/services/connectors/lifecycle';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestTeam, projectSlugFor } from './helpers/app';
import { startFakeMcpServer } from './helpers/fake-mcp-server';

/**
 * A minimal generic OAuth Authorization Server. Serves the AS-metadata
 * well-known doc, an `/authorize` endpoint that auto-approves and 302s back to
 * the redirect_uri with `code` + the passed-through `state`, and a `/token`
 * endpoint. Drives the manual auth-code flow on `oauth.ts` (the `/oauth/callback`
 * + `/projects/:id/oauth/auth-code/start` routes), which the existing suite —
 * focused on the MCP-connector/device-flow paths — never exercises.
 */
interface GenericOAuthSim {
	server: Server;
	baseUrl: string;
	destroy(): Promise<void>;
}

async function startGenericOAuthSim(
	opts: { withMetadata?: boolean; rejectExchange?: boolean; tokenScope?: string | null } = {},
): Promise<GenericOAuthSim> {
	const withMetadata = opts.withMetadata ?? true;
	const app = new HonoApp();

	if (withMetadata) {
		app.get('/.well-known/oauth-authorization-server', (c) => {
			const origin = new URL(c.req.url).origin;
			return c.json({
				issuer: origin,
				authorization_endpoint: `${origin}/authorize`,
				token_endpoint: `${origin}/token`,
				code_challenge_methods_supported: ['S256'],
				scopes_supported: ['read', 'write'],
			});
		});
	}

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
		if (opts.rejectExchange) {
			c.status(400);
			return c.json({ error: 'invalid_grant', error_description: 'bad code' });
		}
		const body = (await c.req.parseBody()) as Record<string, string>;
		const resp: Record<string, unknown> = {
			access_token: `gen-tok-${body.code ?? 'x'}`,
			refresh_token: 'gen-ref',
			token_type: 'bearer',
			expires_in: 3600,
		};
		// tokenScope null → omit scope (exercises the "fall back to manual_config.scopes" branch).
		if (opts.tokenScope !== null) resp.scope = opts.tokenScope ?? 'read write';
		return c.json(resp);
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
let db: Db;
let token: string;
let teamId: string;
let projectSlug: string;
let sim: GenericOAuthSim;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const teamRes = await createTestTeam(db, { name: 'OAuth Routes Co' });
	teamId = (await teamRes.json()).data.id;
	projectSlug = await projectSlugFor(db, teamId);

	sim = await startGenericOAuthSim();
});

afterAll(async () => {
	await sim.destroy();
	await safeClose(db);
});

/** POST a manual-config auth-code start; returns the parsed response + status. */
async function startAuthCode(body: Record<string, unknown>) {
	const res = await app.request(`/api/projects/${projectSlug}/oauth/auth-code/start`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function manualConfig(base: string) {
	return {
		authorize_url: `${base}/authorize`,
		token_url: `${base}/token`,
		client_id: 'cli-123',
		client_secret: 'sec-456',
		scopes: ['read', 'write'],
	};
}

describe('POST /projects/:projectId/oauth/auth-code/start (manual config)', () => {
	it('rejects a missing provider', async () => {
		const { status, body } = await startAuthCode({ manual_config: manualConfig(sim.baseUrl) });
		expect(status).toBe(400);
		expect((body.error as { code: string }).code).toBe('INVALID_REQUEST');
	});

	it('rejects when neither server_url nor manual_config is supplied', async () => {
		const { status, body } = await startAuthCode({ provider: 'notion' });
		expect(status).toBe(400);
		expect((body.error as { message: string }).message).toMatch(/server_url.*manual_config/);
	});

	it('builds an authorize URL from manual_config with PKCE + state', async () => {
		const { status, body } = await startAuthCode({
			provider: 'notion',
			manual_config: manualConfig(sim.baseUrl),
			return_to: '/projects/x',
		});
		expect(status).toBe(200);
		const authUrl = (body.data as { auth_url: string }).auth_url;
		const parsed = new URL(authUrl);
		expect(parsed.origin + parsed.pathname).toBe(`${sim.baseUrl}/authorize`);
		expect(parsed.searchParams.get('client_id')).toBe('cli-123');
		expect(parsed.searchParams.get('code_challenge')).toBeTruthy();
		expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
		expect(parsed.searchParams.get('state')).toBeTruthy();
	});

	it('spec-discovery mode without manual_config returns OAUTH_MANUAL_CONFIG_REQUIRED', async () => {
		// server_url present, metadata discoverable, but no manual_config → DCR isn't
		// implemented for this route, so it must ask for manual_config.
		const { status, body } = await startAuthCode({
			provider: 'notion',
			server_url: `${sim.baseUrl}/mcp`,
		});
		expect(status).toBe(400);
		expect((body.error as { code: string }).code).toBe('OAUTH_MANUAL_CONFIG_REQUIRED');
	});

	it('returns OAUTH_DISCOVERY_FAILED (503) when metadata discovery fails', async () => {
		const noMeta = await startGenericOAuthSim({ withMetadata: false });
		try {
			const res = await app.request(`/api/projects/${projectSlug}/oauth/auth-code/start`, {
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ provider: 'notion', server_url: `${noMeta.baseUrl}/mcp` }),
			});
			expect(res.status).toBe(503);
			expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
				'OAUTH_DISCOVERY_FAILED',
			);
		} finally {
			await noMeta.destroy();
		}
	});
});

describe('GET /oauth/callback (generic auth-code callback)', () => {
	it('completes the flow end-to-end: stores token in an oauth_connections row', async () => {
		const { body } = await startAuthCode({
			provider: 'notion',
			manual_config: manualConfig(sim.baseUrl),
			mcp_connection_name: 'My Notion',
		});
		const authUrl = (body.data as { auth_url: string }).auth_url;
		const authorizeRes = await fetch(authUrl, { redirect: 'manual' });
		expect(authorizeRes.status).toBe(302);
		const loc = new URL(authorizeRes.headers.get('location')!);
		const code = loc.searchParams.get('code')!;
		const state = loc.searchParams.get('state')!;

		const before = await db.query<{ c: number }>(
			`SELECT count(*)::int AS c FROM oauth_connections WHERE provider = 'notion'`,
		);

		const cb = await app.request(
			`/api/oauth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
		);
		expect(cb.status).toBe(200);
		expect(await cb.text()).toContain('OAuth connection complete');

		const after = await db.query<{ provider: string; provider_account_label: string }>(
			`SELECT provider, provider_account_label FROM oauth_connections WHERE provider = 'notion'`,
		);
		expect(after.rows.length).toBe(before.rows[0].c + 1);
		expect(after.rows[after.rows.length - 1].provider_account_label).toBe('My Notion');

		// Token value never leaks into the row; it lives encrypted in secrets.
		const secret = await db.query<{ allowed_hosts: string[] }>(
			`SELECT s.allowed_hosts FROM oauth_connections oc
			 JOIN secrets s ON s.id = oc.access_token_secret_id
			 WHERE oc.provider = 'notion' ORDER BY oc.created_at DESC LIMIT 1`,
		);
		// allowed_hosts inferred from the token_url host.
		expect(secret.rows[0].allowed_hosts.some((h) => h.startsWith('localhost'))).toBe(true);
	});

	it('links an mcp_connection row when mcp_connection_id is in the state', async () => {
		const { row } = await createOrFetchConnector(db, {
			name: 'linktest',
			displayName: 'LinkTest',
			mcpUrl: `${sim.baseUrl}/mcp`,
			mcpTransport: 'http',
		});
		const { body } = await startAuthCode({
			provider: 'linktest',
			manual_config: manualConfig(sim.baseUrl),
			mcp_connection_id: row.id,
		});
		const authUrl = (body.data as { auth_url: string }).auth_url;
		const authorizeRes = await fetch(authUrl, { redirect: 'manual' });
		const loc = new URL(authorizeRes.headers.get('location')!);
		const code = loc.searchParams.get('code')!;
		const state = loc.searchParams.get('state')!;

		const cb = await app.request(
			`/api/oauth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
		);
		expect(cb.status).toBe(200);

		const linked = await db.query<{ oauth_connection_id: string | null }>(
			`SELECT oauth_connection_id FROM mcp_connections WHERE id = $1`,
			[row.id],
		);
		expect(linked.rows[0].oauth_connection_id).toBeTruthy();
	});

	it('renders an error page (200) when the provider returns ?error', async () => {
		const cb = await app.request('/api/oauth/callback?error=access_denied');
		expect(cb.status).toBe(200);
		expect(await cb.text()).toContain('access_denied');
	});

	it('renders missing_code_or_state when code/state are absent', async () => {
		const cb = await app.request('/api/oauth/callback');
		expect(cb.status).toBe(200);
		expect(await cb.text()).toContain('missing_code_or_state');
	});

	it('renders invalid_state for a tampered state param', async () => {
		const cb = await app.request('/api/oauth/callback?code=abc&state=not.a.valid.state');
		expect(cb.status).toBe(200);
		expect(await cb.text()).toContain('invalid_state');
	});

	it('renders exchange_failed when the token endpoint rejects the code', async () => {
		const broken = await startGenericOAuthSim({ rejectExchange: true });
		try {
			const res = await app.request(`/api/projects/${projectSlug}/oauth/auth-code/start`, {
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ provider: 'brk', manual_config: manualConfig(broken.baseUrl) }),
			});
			const authUrl = ((await res.json()) as { data: { auth_url: string } }).data.auth_url;
			const authorizeRes = await fetch(authUrl, { redirect: 'manual' });
			const loc = new URL(authorizeRes.headers.get('location')!);
			const code = loc.searchParams.get('code')!;
			const state = loc.searchParams.get('state')!;
			const cb = await app.request(
				`/api/oauth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
			);
			expect(cb.status).toBe(200);
			expect(await cb.text()).toContain('exchange_failed');
		} finally {
			await broken.destroy();
		}
	});

	it('falls back to manual_config.scopes when the token response omits scope', async () => {
		const noScope = await startGenericOAuthSim({ tokenScope: null });
		try {
			const res = await app.request(`/api/projects/${projectSlug}/oauth/auth-code/start`, {
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ provider: 'noscope', manual_config: manualConfig(noScope.baseUrl) }),
			});
			const authUrl = ((await res.json()) as { data: { auth_url: string } }).data.auth_url;
			const authorizeRes = await fetch(authUrl, { redirect: 'manual' });
			const loc = new URL(authorizeRes.headers.get('location')!);
			const code = loc.searchParams.get('code')!;
			const state = loc.searchParams.get('state')!;
			const cb = await app.request(
				`/api/oauth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
			);
			expect(cb.status).toBe(200);
			const conn = await db.query<{ scopes: string[] }>(
				`SELECT scopes FROM oauth_connections WHERE provider = 'noscope' ORDER BY created_at DESC LIMIT 1`,
			);
			expect(conn.rows[0].scopes).toEqual(['read', 'write']);
		} finally {
			await noScope.destroy();
		}
	});
});

describe('POST /projects/:projectId/auth-start (connector error branches)', () => {
	it('404s for an unknown connector id', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/auth-start`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ connector_id: crypto.randomUUID() }),
		});
		expect(res.status).toBe(404);
	});

	it('400s when connector_id is missing', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/auth-start`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	it('400 CONNECTOR_REVOKED for a revoked connector', async () => {
		const { row } = await createOrFetchConnector(db, {
			name: 'revoked-conn',
			displayName: 'Revoked',
			mcpUrl: `${sim.baseUrl}/mcp`,
			mcpTransport: 'http',
		});
		await db.query(`UPDATE mcp_connections SET revoked_at = now() WHERE id = $1`, [row.id]);
		const res = await app.request(`/api/projects/${projectSlug}/auth-start`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ connector_id: row.id }),
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
			'CONNECTOR_REVOKED',
		);
	});

	it('400 when the connector is not a saas MCP connector', async () => {
		const ins = await db.query<{ id: string }>(
			`INSERT INTO mcp_connections (name, display_name, kind, config, install_status)
			 VALUES ('local-kind', 'Local', 'local'::mcp_connection_kind, '{}'::jsonb, 'installed')
			 RETURNING id`,
		);
		const res = await app.request(`/api/projects/${projectSlug}/auth-start`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ connector_id: ins.rows[0].id }),
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(
			/saas MCP connectors/,
		);
	});

	it('400 when a saas connector has no MCP server url', async () => {
		const ins = await db.query<{ id: string }>(
			`INSERT INTO mcp_connections (name, display_name, kind, config, install_status)
			 VALUES ('nourl-conn', 'NoUrl', 'saas'::mcp_connection_kind, '{}'::jsonb, 'installed')
			 RETURNING id`,
		);
		const res = await app.request(`/api/projects/${projectSlug}/auth-start`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ connector_id: ins.rows[0].id }),
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(
			/no MCP server url/,
		);
	});
});

describe('GET /oauth/mcp-callback (error branches)', () => {
	it('renders missing_code_or_state when params are absent', async () => {
		const cb = await app.request('/api/oauth/mcp-callback');
		expect(cb.status).toBe(200);
		expect(await cb.text()).toContain('missing_code_or_state');
	});

	it('surfaces the provider error code', async () => {
		const cb = await app.request('/api/oauth/mcp-callback?error=server_error');
		expect(cb.status).toBe(200);
		expect(await cb.text()).toContain('server_error');
	});

	it('renders invalid_state for a bad state param', async () => {
		const cb = await app.request('/api/oauth/mcp-callback?code=abc&state=bogus.sig');
		expect(cb.status).toBe(200);
		expect(await cb.text()).toContain('invalid_state');
	});
});

describe('oauth-connections delete + scope-status not-found', () => {
	it('404s deleting a connection that does not exist', async () => {
		const res = await app.request(
			`/api/projects/${projectSlug}/oauth-connections/${crypto.randomUUID()}`,
			{ method: 'DELETE', headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
	});

	it('scope-status 404s for an unknown connection', async () => {
		const res = await app.request(
			`/api/projects/${projectSlug}/oauth-connections/${crypto.randomUUID()}/scope-status`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
	});
});

describe('POST /projects/:projectId/auth-start (DCR discovery/registration failures)', () => {
	it('marks the connector failed + returns OAUTH_DCR_UNSUPPORTED when the AS omits a registration endpoint', async () => {
		const fake = await startFakeMcpServer({ noRegistrationEndpoint: true });
		try {
			const { row } = await createOrFetchConnector(db, {
				name: 'no-dcr',
				displayName: 'NoDCR',
				mcpUrl: `${fake.url}/mcp`,
				mcpTransport: 'http',
			});
			const res = await app.request(`/api/projects/${projectSlug}/auth-start`, {
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ connector_id: row.id }),
			});
			expect(res.status).toBe(400);
			expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
				'OAUTH_DCR_UNSUPPORTED',
			);
			const connector = await getConnector(db, row.id);
			expect(connector?.auth_error).toMatch(/registration_endpoint/);
		} finally {
			await fake.close();
		}
	});

	it('marks the connector failed + returns OAUTH_DCR_FAILED when registration is rejected', async () => {
		const fake = await startFakeMcpServer({ rejectDcr: true });
		try {
			const { row } = await createOrFetchConnector(db, {
				name: 'bad-dcr',
				displayName: 'BadDCR',
				mcpUrl: `${fake.url}/mcp`,
				mcpTransport: 'http',
			});
			const res = await app.request(`/api/projects/${projectSlug}/auth-start`, {
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ connector_id: row.id }),
			});
			expect(res.status).toBe(503);
			expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
				'OAUTH_DCR_FAILED',
			);
			const connector = await getConnector(db, row.id);
			expect(connector?.auth_error).toMatch(/DCR:/);
		} finally {
			await fake.close();
		}
	});
});
