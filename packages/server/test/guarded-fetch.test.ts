import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { resetRuntimeConfig, runtimeConfig, setRuntimeConfig } from '../src/config/runtime';
import { createGuardedFetch, guardedFetch } from '../src/services/egress/guarded-fetch';
import { BlockedEgressTargetError, isBlockedEgressAddress } from '../src/services/egress/net-guard';
import { generateSelfSignedCert } from './helpers/self-signed-cert';

/**
 * The server fetches URLs an agent supplies (a skill file, a connector's MCP
 * endpoint, the OAuth metadata that endpoint points at). Unguarded, that is a
 * server-side request forgery primitive: `http://169.254.169.254/` answers with
 * the cloud provider's instance metadata, and a private address reaches
 * whatever shares the host's network.
 *
 * Every server a test can start listens on loopback, which the real rule
 * refuses. `reachable` applies the real rule to everything except 127.0.0.1, so
 * the redirect handling can be exercised against live servers.
 */
const reachable = createGuardedFetch(
	(address) => address !== '127.0.0.1' && isBlockedEgressAddress(address),
);

interface Seen {
	method: string;
	url: string;
	headers: IncomingMessage['headers'];
	body: string;
}

interface TestServer {
	origin: string;
	seen: Seen[];
	close(): Promise<void>;
}

const open: TestServer[] = [];

afterEach(async () => {
	await Promise.all(open.splice(0).map((s) => s.close()));
	resetRuntimeConfig();
});

async function serve(
	handler: (req: IncomingMessage, res: ServerResponse, seen: Seen) => void,
): Promise<TestServer> {
	const seen: Seen[] = [];
	const server: Server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => chunks.push(c));
		req.on('end', () => {
			const entry = {
				method: req.method ?? '',
				url: req.url ?? '',
				headers: req.headers,
				body: Buffer.concat(chunks).toString(),
			};
			seen.push(entry);
			handler(req, res, entry);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const port = (server.address() as { port: number }).port;
	const handle = {
		origin: `http://127.0.0.1:${port}`,
		seen,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
	open.push(handle);
	return handle;
}

const echo = (_req: IncomingMessage, res: ServerResponse, seen: Seen) => {
	res.setHeader('content-type', 'application/json');
	res.end(JSON.stringify(seen));
};

describe('guardedFetch refuses private and metadata addresses', () => {
	it('refuses the cloud metadata address before any request is made', async () => {
		await expect(
			guardedFetch('http://169.254.169.254/metadata/v1/user-data'),
		).rejects.toBeInstanceOf(BlockedEgressTargetError);
	});

	it('refuses a loopback server by address and by name, and the server sees nothing', async () => {
		const server = await serve(echo);
		const port = new URL(server.origin).port;
		await expect(guardedFetch(`http://127.0.0.1:${port}/`)).rejects.toBeInstanceOf(
			BlockedEgressTargetError,
		);
		await expect(guardedFetch(`http://localhost:${port}/`)).rejects.toBeInstanceOf(
			BlockedEgressTargetError,
		);
		expect(server.seen).toHaveLength(0);
	});

	it('refuses a redirect that leads to a blocked address, at that hop', async () => {
		const server = await serve((_req, res) => {
			res.writeHead(302, { location: 'http://169.254.169.254/metadata/v1/user-data' });
			res.end();
		});
		await expect(reachable(`${server.origin}/start`)).rejects.toBeInstanceOf(
			BlockedEgressTargetError,
		);
		expect(server.seen).toHaveLength(1);
	});

	it('is a plain fetch when the operator allows private targets', async () => {
		setRuntimeConfig({
			...runtimeConfig(),
			egress: { ...runtimeConfig().egress, allowPrivateTargets: true },
		});
		const server = await serve(echo);
		const res = await guardedFetch(`${server.origin}/lan`);
		expect(res.status).toBe(200);
		expect(server.seen).toHaveLength(1);
	});
});

describe('guardedFetch behaves like fetch for an allowed address', () => {
	it('answers with the status, headers and body, and sends the URL host as Host', async () => {
		const server = await serve((_req, res, seen) => {
			res.writeHead(201, { 'content-type': 'application/json', 'x-trace': 'abc' });
			res.end(JSON.stringify(seen));
		});
		const res = await reachable(`${server.origin}/path?q=1`, {
			headers: { 'x-caller': 'yes' },
		});
		expect(res.status).toBe(201);
		expect(res.headers.get('x-trace')).toBe('abc');
		const seen = (await res.json()) as Seen;
		expect(seen.url).toBe('/path?q=1');
		expect(seen.headers.host).toBe(new URL(server.origin).host);
		expect(seen.headers['x-caller']).toBe('yes');
	});

	it('delivers a POST body intact, string and form-encoded', async () => {
		const server = await serve(echo);
		await reachable(`${server.origin}/json`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ a: 1 }),
		});
		await reachable(`${server.origin}/form`, {
			method: 'POST',
			body: new URLSearchParams({ grant_type: 'refresh_token', token: 'r1' }),
		});
		expect(server.seen[0].body).toBe('{"a":1}');
		expect(server.seen[1].body).toBe('grant_type=refresh_token&token=r1');
		expect(server.seen[1].headers['content-type']).toContain('application/x-www-form-urlencoded');
	});

	it('follows a redirect, reporting the final URL', async () => {
		const server = await serve((req, res, seen) => {
			if (req.url === '/start') {
				res.writeHead(302, { location: '/end' });
				res.end();
				return;
			}
			echo(req, res, seen);
		});
		const res = await reachable(`${server.origin}/start`);
		expect(res.status).toBe(200);
		expect(res.url).toBe(`${server.origin}/end`);
		expect(res.redirected).toBe(true);
	});

	it('turns a POST into a bodiless GET on 303, and keeps method and body on 307', async () => {
		const server = await serve((req, res, seen) => {
			if (req.url === '/see-other') {
				res.writeHead(303, { location: '/landed' });
				res.end();
				return;
			}
			if (req.url === '/temporary') {
				res.writeHead(307, { location: '/landed' });
				res.end();
				return;
			}
			echo(req, res, seen);
		});
		const init = { method: 'POST', body: 'payload', headers: { 'content-type': 'text/plain' } };
		const after303 = (await (await reachable(`${server.origin}/see-other`, init)).json()) as Seen;
		expect(after303.method).toBe('GET');
		expect(after303.body).toBe('');
		expect(after303.headers['content-type']).toBeUndefined();
		const after307 = (await (await reachable(`${server.origin}/temporary`, init)).json()) as Seen;
		expect(after307.method).toBe('POST');
		expect(after307.body).toBe('payload');
	});

	it('drops Authorization on a redirect to another origin and keeps it on the same one', async () => {
		const other = await serve(echo);
		const server = await serve((req, res, seen) => {
			if (req.url === '/away') {
				res.writeHead(302, { location: `${other.origin}/elsewhere` });
				res.end();
				return;
			}
			if (req.url === '/home') {
				res.writeHead(302, { location: '/here' });
				res.end();
				return;
			}
			echo(req, res, seen);
		});
		const headers = { authorization: 'Bearer secret' };
		const away = (await (await reachable(`${server.origin}/away`, { headers })).json()) as Seen;
		expect(away.headers.authorization).toBeUndefined();
		const home = (await (await reachable(`${server.origin}/home`, { headers })).json()) as Seen;
		expect(home.headers.authorization).toBe('Bearer secret');
	});

	it('honours the manual and error redirect modes', async () => {
		const server = await serve((_req, res) => {
			res.writeHead(302, { location: '/next' });
			res.end();
		});
		const manual = await reachable(server.origin, { redirect: 'manual' });
		expect(manual.status).toBe(302);
		expect(manual.headers.get('location')).toBe('/next');
		await expect(reachable(server.origin, { redirect: 'error' })).rejects.toBeInstanceOf(TypeError);
	});

	it('gives up after twenty redirects', async () => {
		const server = await serve((req, res) => {
			res.writeHead(302, { location: `${req.url}x` });
			res.end();
		});
		await expect(reachable(`${server.origin}/r`)).rejects.toThrow(/too many redirects/);
		expect(server.seen).toHaveLength(20);
	});

	it('decodes a gzip body', async () => {
		const text = 'compressed skill file '.repeat(200);
		const server = await serve((_req, res) => {
			res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'text/markdown' });
			res.end(gzipSync(text));
		});
		const res = await reachable(server.origin);
		expect(await res.text()).toBe(text);
		expect(res.headers.get('content-encoding')).toBeNull();
	});

	it('rejects with the signal reason on an abort before the reply and during the body', async () => {
		const stalled = await serve(() => {
			// Never answers.
		});
		const before = new AbortController();
		const pending = reachable(stalled.origin, { signal: before.signal });
		setTimeout(() => before.abort(), 20);
		await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

		const trickle = await serve((_req, res) => {
			res.writeHead(200, { 'content-type': 'text/plain' });
			res.write('partial');
			// The rest never arrives.
		});
		const during = new AbortController();
		const res = await reachable(trickle.origin, { signal: during.signal });
		const body = res.text();
		during.abort();
		await expect(body).rejects.toBeDefined();
	});

	it('keeps TLS certificate checking on', async () => {
		const { cert, key } = await generateSelfSignedCert('localhost');
		const requests: string[] = [];
		const server = createHttpsServer({ cert, key }, (req, res) => {
			requests.push(req.url ?? '');
			res.end('ok');
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const port = (server.address() as { port: number }).port;
		try {
			await expect(reachable(`https://127.0.0.1:${port}/`)).rejects.toBeDefined();
			expect(requests).toHaveLength(0);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
