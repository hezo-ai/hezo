import { createServer, type Server } from 'node:http';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	buildAuthorizationUrl,
	discoverMetadata,
	exchangeCode,
} from '../../services/oauth/provider-generic';

interface ProviderSim {
	server: Server;
	baseUrl: string;
	exchangedCodes: Map<string, { codeVerifier: string; redirectUri: string }>;
	destroy(): Promise<void>;
}

async function startProviderSim(
	opts: { withMetadata?: boolean } = { withMetadata: true },
): Promise<ProviderSim> {
	const exchangedCodes = new Map<string, { codeVerifier: string; redirectUri: string }>();
	const app = new Hono();

	if (opts.withMetadata) {
		app.get('/.well-known/oauth-authorization-server', (c) =>
			c.json({
				issuer: 'http://test',
				authorization_endpoint: '/authorize',
				token_endpoint: '/token',
				code_challenge_methods_supported: ['S256'],
				scopes_supported: ['read', 'write'],
			}),
		);
	}

	app.post('/token', async (c) => {
		const body = await c.req.parseBody();
		const code = String(body.code ?? '');
		if (code === 'wrong-code') {
			c.status(400);
			return c.json({ error: 'invalid_grant', error_description: 'bad code' });
		}
		exchangedCodes.set(code, {
			codeVerifier: String(body.code_verifier ?? ''),
			redirectUri: String(body.redirect_uri ?? ''),
		});
		return c.json({
			access_token: `tok-${code}`,
			refresh_token: `ref-${code}`,
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
		const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
		const response = await app.fetch(
			new Request(url, {
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
		server,
		baseUrl: `http://localhost:${port}`,
		exchangedCodes,
		async destroy() {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

let sim: ProviderSim;

beforeAll(async () => {
	sim = await startProviderSim({ withMetadata: true });
});

afterAll(async () => {
	await sim.destroy();
});

describe('OAuth generic provider', () => {
	it('discovers metadata via /.well-known/oauth-authorization-server', async () => {
		const md = await discoverMetadata(sim.baseUrl);
		expect(md.authorization_endpoint).toBe('/authorize');
		expect(md.token_endpoint).toBe('/token');
		expect(md.code_challenge_methods_supported).toContain('S256');
	});

	it('throws when no well-known endpoint responds', async () => {
		const noMeta = await startProviderSim({ withMetadata: false });
		try {
			await expect(discoverMetadata(noMeta.baseUrl)).rejects.toThrow(/discovery failed/);
		} finally {
			await noMeta.destroy();
		}
	});

	it('builds an authorization URL with PKCE and state', () => {
		const url = buildAuthorizationUrl({
			authorizeUrl: 'https://provider/auth',
			clientId: 'client-1',
			scopes: ['read', 'write'],
			redirectUri: 'http://127.0.0.1:3100/cb',
			state: 'state-1',
			codeChallenge: 'challenge-1',
		});
		const parsed = new URL(url);
		expect(parsed.origin + parsed.pathname).toBe('https://provider/auth');
		expect(parsed.searchParams.get('response_type')).toBe('code');
		expect(parsed.searchParams.get('client_id')).toBe('client-1');
		expect(parsed.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:3100/cb');
		expect(parsed.searchParams.get('state')).toBe('state-1');
		expect(parsed.searchParams.get('code_challenge')).toBe('challenge-1');
		expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
		expect(parsed.searchParams.get('scope')).toBe('read write');
	});

	it('exchanges a code and parses access_token + refresh_token + expires_at', async () => {
		const result = await exchangeCode({
			tokenUrl: `${sim.baseUrl}/token`,
			clientId: 'client-1',
			code: 'auth-1',
			codeVerifier: 'verifier-1',
			redirectUri: 'http://127.0.0.1:3100/cb',
		});
		expect(result.accessToken).toBe('tok-auth-1');
		expect(result.refreshToken).toBe('ref-auth-1');
		expect(result.expiresAt).toBeInstanceOf(Date);
		expect(result.expiresAt!.getTime()).toBeGreaterThan(Date.now());
		expect(sim.exchangedCodes.get('auth-1')).toEqual({
			codeVerifier: 'verifier-1',
			redirectUri: 'http://127.0.0.1:3100/cb',
		});
	});

	it('surfaces token-endpoint errors with their description', async () => {
		await expect(
			exchangeCode({
				tokenUrl: `${sim.baseUrl}/token`,
				clientId: 'client-1',
				code: 'wrong-code',
				codeVerifier: 'v',
				redirectUri: 'http://127.0.0.1:3100/cb',
			}),
		).rejects.toThrow(/invalid_grant/);
	});
});
