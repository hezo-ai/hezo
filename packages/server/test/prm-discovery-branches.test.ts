import { describe, expect, it } from 'vitest';
import {
	discoverMcpAuthorization,
	fetchProtectedResourceMetadata,
	probeForProtectedResourceMetadata,
	wellKnownPrmUrl,
} from '../src/services/oauth/prm-discovery';
import type { FetchFn } from '../src/services/oauth/provider-generic';

/**
 * Branch-coverage companion for `oauth/prm-discovery.ts`. The happy path runs
 * against a fake server in `connectors.test.ts`; here we drive every
 * conditional arm with a stub `FetchFn` (production code accepts an injected
 * fetch). No real network. Covers:
 *  - wellKnownPrmUrl origin derivation (sub-path stripped, port preserved)
 *  - probe: 401-with-hint, 401-with-lowercase-header, 401-without-hint,
 *    non-401, and network-error fallbacks
 *  - fetchProtectedResourceMetadata: non-ok, empty/absent authorization_servers
 *  - discoverMcpAuthorization: PRM-fetch-failure wrapping + full walk
 */

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json', ...headers },
	});
}

describe('wellKnownPrmUrl', () => {
	it('derives the origin-level well-known URL, dropping the MCP sub-path', () => {
		expect(wellKnownPrmUrl('https://api.example.com/mcp/v1')).toBe(
			'https://api.example.com/.well-known/oauth-protected-resource',
		);
	});
	it('preserves a non-default port', () => {
		expect(wellKnownPrmUrl('http://localhost:8787/mcp')).toBe(
			'http://localhost:8787/.well-known/oauth-protected-resource',
		);
	});
});

describe('probeForProtectedResourceMetadata', () => {
	const MCP = 'https://srv.example/mcp';
	const FALLBACK = 'https://srv.example/.well-known/oauth-protected-resource';

	it('returns the resource_metadata pointer from a 401 WWW-Authenticate (canonical case)', async () => {
		const fetchFn: FetchFn = async () =>
			new Response('unauthorized', {
				status: 401,
				headers: {
					'WWW-Authenticate':
						'Bearer resource_metadata="https://srv.example/.well-known/oauth-protected-resource/custom"',
				},
			});
		expect(await probeForProtectedResourceMetadata(MCP, fetchFn)).toBe(
			'https://srv.example/.well-known/oauth-protected-resource/custom',
		);
	});

	it('reads the hint from a lowercase www-authenticate header', async () => {
		const fetchFn: FetchFn = async () =>
			new Response('unauthorized', {
				status: 401,
				headers: { 'www-authenticate': 'Bearer resource_metadata="https://srv.example/prm"' },
			});
		expect(await probeForProtectedResourceMetadata(MCP, fetchFn)).toBe('https://srv.example/prm');
	});

	it('falls back to well-known on a 401 that lacks the resource_metadata hint', async () => {
		const fetchFn: FetchFn = async () =>
			new Response('unauthorized', {
				status: 401,
				headers: { 'WWW-Authenticate': 'Bearer realm="x"' },
			});
		expect(await probeForProtectedResourceMetadata(MCP, fetchFn)).toBe(FALLBACK);
	});

	it('falls back to well-known on a 401 with no WWW-Authenticate header at all', async () => {
		const fetchFn: FetchFn = async () => new Response('unauthorized', { status: 401 });
		expect(await probeForProtectedResourceMetadata(MCP, fetchFn)).toBe(FALLBACK);
	});

	it('falls back to well-known on a non-401 response (e.g. 200)', async () => {
		const fetchFn: FetchFn = async () => jsonResponse({ ok: true }, 200);
		expect(await probeForProtectedResourceMetadata(MCP, fetchFn)).toBe(FALLBACK);
	});

	it('falls back to well-known on a network error', async () => {
		const fetchFn: FetchFn = async () => {
			throw new Error('ECONNREFUSED');
		};
		expect(await probeForProtectedResourceMetadata(MCP, fetchFn)).toBe(FALLBACK);
	});
});

describe('fetchProtectedResourceMetadata', () => {
	it('returns the document when authorization_servers is non-empty', async () => {
		const fetchFn: FetchFn = async () =>
			jsonResponse({
				resource: 'https://srv.example',
				authorization_servers: ['https://as.example'],
			});
		const prm = await fetchProtectedResourceMetadata('https://srv.example/prm', fetchFn);
		expect(prm.authorization_servers).toEqual(['https://as.example']);
	});

	it('throws on a non-ok PRM fetch', async () => {
		const fetchFn: FetchFn = async () => jsonResponse({}, 404);
		await expect(
			fetchProtectedResourceMetadata('https://srv.example/prm', fetchFn),
		).rejects.toThrow(/PRM fetch failed: .* → 404/);
	});

	it('throws when authorization_servers is missing', async () => {
		const fetchFn: FetchFn = async () => jsonResponse({ resource: 'https://srv.example' });
		await expect(
			fetchProtectedResourceMetadata('https://srv.example/prm', fetchFn),
		).rejects.toThrow(/missing authorization_servers/);
	});

	it('throws when authorization_servers is an empty array', async () => {
		const fetchFn: FetchFn = async () =>
			jsonResponse({ resource: 'https://srv.example', authorization_servers: [] });
		await expect(
			fetchProtectedResourceMetadata('https://srv.example/prm', fetchFn),
		).rejects.toThrow(/missing authorization_servers/);
	});
});

describe('discoverMcpAuthorization', () => {
	it('walks probe → PRM → AS metadata for a full discovery', async () => {
		const fetchFn: FetchFn = async (input) => {
			const url = String(input);
			if (url === 'https://srv.example/mcp') {
				return new Response('unauthorized', {
					status: 401,
					headers: { 'WWW-Authenticate': 'Bearer resource_metadata="https://srv.example/prm"' },
				});
			}
			if (url === 'https://srv.example/prm') {
				return jsonResponse({
					resource: 'https://srv.example',
					authorization_servers: ['https://as.example'],
					scopes_supported: ['read'],
				});
			}
			// AS metadata discovery probes /.well-known/oauth-authorization-server first.
			if (url.endsWith('/.well-known/oauth-authorization-server')) {
				return jsonResponse({
					issuer: 'https://as.example',
					authorization_endpoint: 'https://as.example/authorize',
					token_endpoint: 'https://as.example/token',
				});
			}
			return jsonResponse({}, 404);
		};
		const result = await discoverMcpAuthorization('https://srv.example/mcp', fetchFn);
		expect(result.resource).toBe('https://srv.example');
		expect(result.authorizationServerUrl).toBe('https://as.example');
		expect(result.asMetadata.token_endpoint).toBe('https://as.example/token');
		expect(result.prm.scopes_supported).toEqual(['read']);
	});

	it('wraps a PRM-fetch failure with the probe URL + cause', async () => {
		const fetchFn: FetchFn = async (input) => {
			const url = String(input);
			// Probe yields no 401 → falls back to well-known, which then 404s.
			if (url === 'https://srv.example/mcp') return jsonResponse({}, 200);
			return jsonResponse({}, 404);
		};
		await expect(discoverMcpAuthorization('https://srv.example/mcp', fetchFn)).rejects.toThrow(
			/Could not discover OAuth endpoints for https:\/\/srv\.example\/mcp/,
		);
	});
});
