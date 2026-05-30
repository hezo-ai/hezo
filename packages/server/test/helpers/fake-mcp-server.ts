import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { Hono } from 'hono';
import { getAvailablePort } from './port';

/**
 * Test fixture: a fake MCP server that simultaneously plays MCP resource,
 * PRM authority, and OAuth Authorization Server for end-to-end testing of
 * the connector flow.
 *
 * Endpoints (all on the same origin):
 * - `GET /mcp`                                  → 401 + WWW-Authenticate: Bearer resource_metadata="<base>/.well-known/oauth-protected-resource"
 *                                                  unless a valid Bearer token is presented, then 200 {ok: true}
 * - `GET /.well-known/oauth-protected-resource` → PRM (RFC 9728): `{ resource, authorization_servers: ["<base>"] }`
 * - `GET /.well-known/oauth-authorization-server` → AS metadata (RFC 8414)
 * - `POST /register`                            → DCR (RFC 7591): returns `{ client_id }`
 * - `GET  /authorize`                           → 302 to `redirect_uri?code=...&state=...` (auto-approves)
 * - `POST /token`                               → token exchange, returns access + refresh tokens
 *
 * Configurable failure modes for tests:
 * - `rejectDcr: true`        → /register returns 400
 * - `rejectExchange: true`   → /token returns 400 invalid_grant
 * - `noRegistrationEndpoint` → AS metadata omits registration_endpoint
 */

export interface FakeMcpServerOptions {
	rejectDcr?: boolean;
	rejectExchange?: boolean;
	noRegistrationEndpoint?: boolean;
	/**
	 * Mimic real-world servers (DatoCMS as of 2026-05) that return
	 * `WWW-Authenticate: Bearer error="invalid_token", error_description="..."`
	 * without the RFC 9728 `resource_metadata=` hint. PRM is still served at
	 * the standard well-known path; the client must fall back.
	 */
	omitWwwAuthenticateResourceMetadata?: boolean;
}

export interface FakeMcpServer {
	url: string;
	port: number;
	close: () => Promise<void>;
	/** Last DCR-issued client_id, for assertions. */
	lastClientId: () => string | null;
	/** Last issued access token, for assertions. */
	lastAccessToken: () => string | null;
	/** Pending authorize requests (one entry per /authorize hit). */
	authorizeRequests: () => Array<{ clientId: string; redirectUri: string; state: string }>;
}

export async function startFakeMcpServer(opts: FakeMcpServerOptions = {}): Promise<FakeMcpServer> {
	const port = await getAvailablePort();
	const base = `http://127.0.0.1:${port}`;

	const clients = new Map<string, { redirect_uris: string[] }>();
	const codes = new Map<string, { clientId: string; redirectUri: string; codeChallenge: string }>();
	const tokens = new Set<string>();
	const authorizeRequests: Array<{ clientId: string; redirectUri: string; state: string }> = [];
	let lastClientId: string | null = null;
	let lastAccessToken: string | null = null;

	const app = new Hono();

	// MCP resource endpoint.
	app.get('/mcp', (c) => {
		const auth = c.req.header('authorization') ?? '';
		const token = auth.replace(/^Bearer\s+/i, '');
		if (token && tokens.has(token)) {
			return c.json({ ok: true, message: 'authenticated' });
		}
		c.header(
			'WWW-Authenticate',
			opts.omitWwwAuthenticateResourceMetadata
				? `Bearer error="invalid_token", error_description="Missing Authorization header"`
				: `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
		);
		return c.json({ error: 'unauthorized' }, 401);
	});

	// PRM.
	app.get('/.well-known/oauth-protected-resource', (c) =>
		c.json({
			resource: `${base}/mcp`,
			authorization_servers: [base],
			scopes_supported: ['read', 'write'],
		}),
	);

	// AS metadata.
	app.get('/.well-known/oauth-authorization-server', (c) => {
		const md: Record<string, unknown> = {
			issuer: base,
			authorization_endpoint: `${base}/authorize`,
			token_endpoint: `${base}/token`,
			scopes_supported: ['read', 'write'],
			code_challenge_methods_supported: ['S256'],
			response_types_supported: ['code'],
			grant_types_supported: ['authorization_code', 'refresh_token'],
			token_endpoint_auth_methods_supported: ['none'],
		};
		if (!opts.noRegistrationEndpoint) md.registration_endpoint = `${base}/register`;
		return c.json(md);
	});

	// DCR.
	app.post('/register', async (c) => {
		if (opts.rejectDcr) {
			return c.json({ error: 'invalid_client_metadata' }, 400);
		}
		const body = (await c.req.json().catch(() => ({}))) as { redirect_uris?: string[] };
		const redirect_uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
		if (redirect_uris.length === 0) {
			return c.json({ error: 'invalid_redirect_uri' }, 400);
		}
		const clientId = `fake_${randomBytes(8).toString('hex')}`;
		clients.set(clientId, { redirect_uris });
		lastClientId = clientId;
		return c.json({
			client_id: clientId,
			redirect_uris,
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			token_endpoint_auth_method: 'none',
		});
	});

	// Authorize — auto-approves immediately and 302s to redirect_uri.
	app.get('/authorize', (c) => {
		const clientId = c.req.query('client_id') ?? '';
		const redirectUri = c.req.query('redirect_uri') ?? '';
		const state = c.req.query('state') ?? '';
		const codeChallenge = c.req.query('code_challenge') ?? '';
		const client = clients.get(clientId);
		if (!client) {
			return c.text(`unknown client_id: ${clientId}`, 400);
		}
		if (!client.redirect_uris.includes(redirectUri)) {
			return c.text(`redirect_uri not registered for ${clientId}`, 400);
		}
		authorizeRequests.push({ clientId, redirectUri, state });
		const code = `code_${randomBytes(12).toString('hex')}`;
		codes.set(code, { clientId, redirectUri, codeChallenge });
		const sep = redirectUri.includes('?') ? '&' : '?';
		const target = `${redirectUri}${sep}code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
		return c.redirect(target, 302);
	});

	// Token exchange.
	app.post('/token', async (c) => {
		if (opts.rejectExchange) {
			return c.json({ error: 'invalid_grant' }, 400);
		}
		const ct = c.req.header('content-type') ?? '';
		let params: URLSearchParams;
		if (ct.includes('application/x-www-form-urlencoded')) {
			params = new URLSearchParams(await c.req.text());
		} else {
			params = new URLSearchParams(await c.req.text());
		}
		const grantType = params.get('grant_type');
		const code = params.get('code') ?? '';
		const codeVerifier = params.get('code_verifier') ?? '';
		const redirectUri = params.get('redirect_uri') ?? '';
		const clientId = params.get('client_id') ?? '';

		if (grantType !== 'authorization_code') {
			return c.json({ error: 'unsupported_grant_type' }, 400);
		}
		const stored = codes.get(code);
		if (!stored) return c.json({ error: 'invalid_grant', error_description: 'unknown code' }, 400);
		if (stored.clientId !== clientId) {
			return c.json({ error: 'invalid_grant', error_description: 'client mismatch' }, 400);
		}
		if (stored.redirectUri !== redirectUri) {
			return c.json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }, 400);
		}
		// PKCE verification — challenge is S256(verifier). We don't recompute SHA256
		// in the fixture; we just confirm the verifier is non-empty when a challenge
		// was set. Real ASes would check the hash.
		if (stored.codeChallenge && !codeVerifier) {
			return c.json({ error: 'invalid_grant', error_description: 'missing verifier' }, 400);
		}
		codes.delete(code);
		const accessToken = `tok_${randomBytes(16).toString('hex')}`;
		tokens.add(accessToken);
		lastAccessToken = accessToken;
		return c.json({
			access_token: accessToken,
			refresh_token: `refresh_${randomBytes(16).toString('hex')}`,
			expires_in: 3600,
			token_type: 'Bearer',
			scope: 'read write',
		});
	});

	const server: Server = createServer(async (req, res) => {
		const url = new URL(req.url ?? '/', base);
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		const body = Buffer.concat(chunks);
		const headers = new Headers();
		for (const [k, v] of Object.entries(req.headers)) {
			if (typeof v === 'string') headers.set(k, v);
			else if (Array.isArray(v)) headers.set(k, v.join(', '));
		}
		const request = new Request(url.toString(), {
			method: req.method,
			headers,
			body: ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : body,
			// @ts-expect-error — duplex required for body-bearing requests in some node versions
			duplex: 'half',
		});
		// Hono allows manual redirects so we need to disable Response.redirect's
		// "follow" semantics — pass response through with manual handling.
		const response = await app.fetch(request);
		res.statusCode = response.status;
		response.headers.forEach((v, k) => {
			res.setHeader(k, v);
		});
		const buf = Buffer.from(await response.arrayBuffer());
		res.end(buf);
	});

	await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

	return {
		url: base,
		port,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			}),
		lastClientId: () => lastClientId,
		lastAccessToken: () => lastAccessToken,
		authorizeRequests: () => [...authorizeRequests],
	};
}
