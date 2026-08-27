import { createServer, type Server } from 'node:http';
import type { Hono } from 'hono';
import { Hono as HonoApp } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { createOrFetchConnector, getConnector } from '../src/services/connectors/lifecycle';
import { createConnection } from '../src/services/oauth/connection-store';
import { registerGenericOAuthRefresh } from '../src/services/oauth/generic-refresh';
import { exchangeCode, refreshAccessToken } from '../src/services/oauth/provider-generic';
import { signState } from '../src/services/oauth/state';
import { clearRefreshFns, refreshExpiringTokens } from '../src/services/oauth/token-resolver';
import { safeClose } from './helpers';
import { createTestApp, createTestTeam } from './helpers/app';

/**
 * RFC 8707 resource indicators on the token and refresh grants.
 *
 * `buildAuthorizationUrl` has always sent `resource`; the token request never
 * did. The MCP authorization spec requires it on both, and an AS that scopes
 * tokens per resource answers the mismatched exchange with `invalid_target` -
 * which reached the operator as the single word `exchange_failed`, with the
 * useful half of the sentence left in a server log. Both halves are pinned
 * here: the parameter goes out, and a rejection says why.
 */
let app: Hono<Env>;
let db: Db;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let sim: TokenSim;

const RESOURCE = 'https://mcp.example.com/mcp';
const realFetch = globalThis.fetch;

interface TokenSim {
	baseUrl: string;
	bodies: Record<string, string>[];
	destroy(): Promise<void>;
}

/**
 * An AS that records every token-request body, and refuses the exchange the way
 * a resource-scoped one does when `resource` is missing.
 */
async function startTokenSim(): Promise<TokenSim> {
	const bodies: Record<string, string>[] = [];
	const inner = new HonoApp();
	inner.post('/token', async (c) => {
		const body = (await c.req.parseBody()) as Record<string, string>;
		bodies.push(body);
		if (!body.resource) {
			return c.json(
				{
					error: 'invalid_target',
					// Quotes and a closing script tag on purpose: this text is
					// interpolated into the callback page twice, so it doubles as the
					// escaping fixture for both slots.
					error_description: 'the "resource" parameter is required </script><img src=x>',
				},
				400,
			);
		}
		return c.json({ access_token: `tok-${body.code}`, token_type: 'bearer', expires_in: 3600 });
	});

	const server: Server = createServer(async (req, res) => {
		const headers = new Headers();
		for (const [k, v] of Object.entries(req.headers)) {
			if (v) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
		}
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		const response = await inner.fetch(
			new Request(`http://localhost${req.url}`, {
				method: req.method,
				headers,
				body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
			}),
		);
		res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
		res.end(Buffer.from(await response.arrayBuffer()));
	});
	await new Promise<void>((resolve) => server.listen(0, resolve));
	const addr = server.address();
	const port = typeof addr === 'object' && addr ? addr.port : 0;
	return {
		baseUrl: `http://127.0.0.1:${port}`,
		bodies,
		destroy: () => new Promise((resolve) => server.close(() => resolve())),
	};
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	masterKeyManager = ctx.masterKeyManager;
	teamId = (await (await createTestTeam(db, { name: 'Resource Indicator Co' })).json()).data.id;
	sim = await startTokenSim();
});

afterEach(() => {
	clearRefreshFns();
	globalThis.fetch = realFetch;
	sim.bodies.length = 0;
});

afterAll(async () => {
	await sim.destroy();
	await safeClose(db);
});

describe('exchangeCode', () => {
	it('sends resource when given one', async () => {
		const token = await exchangeCode({
			tokenUrl: `${sim.baseUrl}/token`,
			clientId: 'c1',
			code: 'abc',
			codeVerifier: 'v',
			redirectUri: 'http://localhost/cb',
			resource: RESOURCE,
		});
		expect(token.accessToken).toBe('tok-abc');
		expect(sim.bodies[0].resource).toBe(RESOURCE);
	});

	it('omits resource entirely when none is given', async () => {
		// Not an empty string: an AS that does understand the parameter must not
		// see it at all for a flow whose authorization request never sent it.
		await expect(
			exchangeCode({
				tokenUrl: `${sim.baseUrl}/token`,
				clientId: 'c1',
				code: 'abc',
				codeVerifier: 'v',
				redirectUri: 'http://localhost/cb',
			}),
		).rejects.toThrow(/invalid_target/);
		expect('resource' in sim.bodies[0]).toBe(false);
	});
});

describe('refreshAccessToken', () => {
	it('sends resource on the refresh grant', async () => {
		await refreshAccessToken({
			tokenUrl: `${sim.baseUrl}/token`,
			clientId: 'c1',
			refreshToken: 'r1',
			resource: RESOURCE,
		});
		expect(sim.bodies[0].grant_type).toBe('refresh_token');
		expect(sim.bodies[0].resource).toBe(RESOURCE);
	});
});

describe('the generic host-side refresh', () => {
	it('carries the connection’s recorded resource_url', async () => {
		registerGenericOAuthRefresh();
		await createConnection(
			{ db, masterKeyManager },
			{
				provider: 'mcp:resource-refresh',
				providerAccountId: 'mcp:resource-refresh:acct',
				providerAccountLabel: 'Resource Refresh',
				accessToken: 'stale',
				refreshToken: 'r-old',
				scopes: [],
				expiresAt: new Date(Date.now() - 1_000),
				allowedHosts: ['mcp.example.com'],
				metadata: {
					token_url: `${sim.baseUrl}/token`,
					client_id: 'c1',
					resource_url: RESOURCE,
				},
			},
		);

		await refreshExpiringTokens({ db, masterKeyManager });

		const refresh = sim.bodies.find((b) => b.grant_type === 'refresh_token');
		expect(refresh?.resource).toBe(RESOURCE);
	});
});

describe('GET /oauth/mcp-callback', () => {
	async function callbackFor(name: string, resourceUrl: string | undefined) {
		const { row } = await createOrFetchConnector(db, {
			name,
			displayName: name,
			mcpUrl: RESOURCE,
			mcpTransport: 'http',
		});
		const { state } = await signState(masterKeyManager, {
			teamId,
			projectId: null,
			provider: `mcp:${row.id}`,
			redirectUri: 'http://localhost/api/oauth/mcp-callback',
			returnTo: '/',
			mcpConnectionId: row.id,
			mcpConnectionName: name,
			manualConfig: {
				authorize_url: `${sim.baseUrl}/authorize`,
				token_url: `${sim.baseUrl}/token`,
				client_id: 'c1',
				scopes: ['full_access'],
			},
			resourceUrl,
		});
		const res = await app.request(
			`/api/oauth/mcp-callback?code=code-1&state=${encodeURIComponent(state)}`,
		);
		return { row, res };
	}

	it('sends the state’s resource on the exchange, completing the connect', async () => {
		const { res } = await callbackFor('mcp-resource-ok', RESOURCE);
		expect(await res.text()).toContain('OAuth connection complete');
		expect(sim.bodies[0].resource).toBe(RESOURCE);
		expect(sim.bodies[0].grant_type).toBe('authorization_code');
	});

	it('names what the token endpoint actually said, escaped, and records it', async () => {
		// No resourceUrl in the state, so the sim refuses - standing in for the
		// real failure this fixes, where the operator saw only `exchange_failed`.
		const { row, res } = await callbackFor('mcp-resource-missing', undefined);
		const html = await res.text();

		expect(html).toContain('exchange_failed');
		expect(html).toContain('invalid_target');
		// The AS controls this text and it lands in two slots, so neither may take
		// it as markup: the paragraph escapes it, and the script literal escapes
		// the angle brackets that would otherwise close the element early.
		expect(html).toContain('&quot;resource&quot;');
		expect(html).toContain('&lt;/script&gt;&lt;img src=x&gt;');
		expect(html).toContain('\\u003c/script\\u003e');
		// One opening and one closing script tag: ours, and nothing injected.
		expect(html.match(/<\/script>/g)?.length).toBe(1);
		expect(html).not.toContain('<img src=x>');

		// The same sentence lands on the connector, which is what the card renders.
		const after = await getConnector(db, row.id);
		expect(after?.auth_error).toContain('invalid_target');
	});
});
