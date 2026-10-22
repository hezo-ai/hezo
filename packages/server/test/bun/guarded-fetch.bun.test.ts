import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { gzipSync } from 'node:zlib';
import { createGuardedFetch, guardedFetch } from '../../src/services/egress/guarded-fetch';
import {
	BlockedEgressTargetError,
	isBlockedEgressAddress,
} from '../../src/services/egress/net-guard';

// Runtime tier: runs under `bun test` on the production Bun runtime.
// `guardedFetch` dials through `node:http` / `node:https` rather than `fetch`
// (it must connect to the address it checked), and wraps the reply in a web
// `Response` via `Readable.toWeb`. Bun's `node:http` diverges from Node's in
// exactly the places this leans on: request bodies (a `lookup` option drops
// them, see `resolveGuardedAddress`), when `close` fires, and stream
// conversion. A Node-only test would pass while production broke.

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
});

async function serve(
	handler: (req: IncomingMessage, res: ServerResponse, seen: Seen) => void,
): Promise<TestServer> {
	const seen: Seen[] = [];
	// Sockets are tracked and destroyed by hand: Bun's `closeAllConnections()`
	// does not reach a response still streaming, which the abort case leaves.
	const sockets = new Set<Socket>();
	const server = createServer((req, res) => {
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
	server.on('connection', (s: Socket) => {
		sockets.add(s);
		s.on('close', () => sockets.delete(s));
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const port = (server.address() as { port: number }).port;
	const handle = {
		origin: `http://127.0.0.1:${port}`,
		seen,
		close: () =>
			new Promise<void>((resolve) => {
				for (const s of sockets) s.destroy();
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

describe('guardedFetch on Bun', () => {
	test('refuses the cloud metadata address and a loopback server', async () => {
		const server = await serve(echo);
		await expect(
			guardedFetch('http://169.254.169.254/metadata/v1/user-data'),
		).rejects.toBeInstanceOf(BlockedEgressTargetError);
		await expect(guardedFetch(`${server.origin}/`)).rejects.toBeInstanceOf(
			BlockedEgressTargetError,
		);
		expect(server.seen.length).toBe(0);
	});

	test('answers a GET with status, headers, body and the URL host as Host', async () => {
		const server = await serve((_req, res, seen) => {
			res.writeHead(201, { 'content-type': 'application/json', 'x-trace': 'abc' });
			res.end(JSON.stringify(seen));
		});
		const res = await reachable(`${server.origin}/path?q=1`);
		expect(res.status).toBe(201);
		expect(res.headers.get('x-trace')).toBe('abc');
		const seen = (await res.json()) as Seen;
		expect(seen.url).toBe('/path?q=1');
		expect(seen.headers.host).toBe(new URL(server.origin).host);
	});

	test('delivers POST bodies intact', async () => {
		const server = await serve(echo);
		await reachable(`${server.origin}/json`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize' }),
		});
		await reachable(`${server.origin}/form`, {
			method: 'POST',
			body: new URLSearchParams({ grant_type: 'authorization_code', code: 'c1' }),
		});
		expect(server.seen[0].body).toBe('{"jsonrpc":"2.0","method":"initialize"}');
		expect(server.seen[1].body).toBe('grant_type=authorization_code&code=c1');
	});

	test('re-checks a redirect hop and reports the final URL of an allowed one', async () => {
		const server = await serve((req, res, seen) => {
			if (req.url === '/meta') {
				res.writeHead(302, { location: 'http://169.254.169.254/' });
				res.end();
				return;
			}
			if (req.url === '/start') {
				res.writeHead(302, { location: '/end' });
				res.end();
				return;
			}
			echo(req, res, seen);
		});
		await expect(reachable(`${server.origin}/meta`)).rejects.toBeInstanceOf(
			BlockedEgressTargetError,
		);
		const res = await reachable(`${server.origin}/start`);
		expect(res.url).toBe(`${server.origin}/end`);
		expect(res.redirected).toBe(true);
	});

	test('decodes a gzip body', async () => {
		const text = 'compressed '.repeat(500);
		const server = await serve((_req, res) => {
			res.writeHead(200, { 'content-encoding': 'gzip' });
			res.end(gzipSync(text));
		});
		expect(await (await reachable(server.origin)).text()).toBe(text);
	});

	test('an abort during the body rejects the read', async () => {
		const server = await serve((_req, res) => {
			res.writeHead(200, { 'content-type': 'text/plain' });
			res.write('partial');
		});
		const controller = new AbortController();
		const res = await reachable(server.origin, { signal: controller.signal });
		const body = res.text();
		controller.abort();
		await expect(body).rejects.toBeDefined();
	});
});
