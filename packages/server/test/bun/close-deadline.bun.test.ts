import { describe, expect, test } from 'bun:test';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { type AddressInfo, createServer as createNetServer, connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { closeServerWithDeadline } from '../../src/lib/net';
import { generateSelfSignedCert } from '../helpers/self-signed-cert';

// Runtime tier: this spec runs under `bun test`, exercising server close
// semantics on the production Bun runtime. `server.close()`'s callback only
// fires once every accepted connection ends, and Bun's connection accounting
// for hijacked CONNECT sockets has diverged from Node's — a close that never
// completes wedged the agent-run completion path in production (agents stuck
// "running" forever). These tests pin the contract: closeServerWithDeadline
// always resolves, bounded by its deadline, connections or not.

describe('closeServerWithDeadline', () => {
	test('resolves promptly for a server with no connections', async () => {
		const server = createHttpServer();
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));

		const started = Date.now();
		await closeServerWithDeadline(server, 'test:idle', 5_000);
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	test('resolves while an http keep-alive connection is still open', async () => {
		const server = createHttpServer((_req, res) => res.end('ok'));
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
		const port = (server.address() as AddressInfo).port;

		// A raw socket holding a keep-alive connection open across the close.
		const client = netConnect({ host: '127.0.0.1', port });
		await new Promise<void>((resolve) => client.on('connect', () => resolve()));
		client.write('GET / HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n');
		await new Promise((resolve) => setTimeout(resolve, 100));

		const started = Date.now();
		await closeServerWithDeadline(server, 'test:keep-alive', 2_000);
		expect(Date.now() - started).toBeLessThanOrEqual(2_500);
		client.destroy();
	});

	test('resolves while a hijacked CONNECT tunnel is still open', async () => {
		const server = createHttpServer();
		server.on('connect', (_req, socket) => {
			socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
		const port = (server.address() as AddressInfo).port;

		const client = netConnect({ host: '127.0.0.1', port });
		await new Promise<void>((resolve) => client.on('connect', () => resolve()));
		client.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');
		await new Promise((resolve) => setTimeout(resolve, 100));

		const started = Date.now();
		await closeServerWithDeadline(server, 'test:connect-tunnel', 2_000);
		expect(Date.now() - started).toBeLessThanOrEqual(2_500);
		client.destroy();
	});

	// The production failure mode (egress per-host server serving a GitHub MCP SSE
	// channel). Under Bun, `closeAllConnections()` does not sever a live accepted
	// https connection, so when the caller has NOT destroyed that socket itself
	// `server.close()`'s drain callback never fires and the helper would eat the
	// whole deadline and warn on every teardown. The listening handle, however,
	// releases promptly — so resolution must be gated on that, not on the drain
	// callback. (The egress proxy destroys most sockets it tracks; this guards the
	// case where one escapes that tracking and only `closeAllConnections` is left.)
	test('resolves promptly while a live accepted https connection is still open', async () => {
		const { cert, key } = await generateSelfSignedCert('localhost');
		const server = createHttpsServer({ cert, key }, (_req, res) => {
			// An SSE-style response that never ends, matching a Streamable-HTTP MCP
			// server→client channel.
			res.writeHead(200, { 'content-type': 'text/event-stream' });
			res.write(': open\n\n');
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
		const port = (server.address() as AddressInfo).port;

		const client = tlsConnect({ host: '127.0.0.1', port, rejectUnauthorized: false });
		await new Promise<void>((resolve, reject) => {
			client.once('data', () => resolve());
			client.once('error', reject);
			client.setTimeout(10_000, () => reject(new Error('no response')));
			client.on('secureConnect', () => {
				client.write('GET /sse HTTP/1.1\r\nHost: localhost\r\nAccept: text/event-stream\r\n\r\n');
			});
		});

		// Do NOT destroy the accepted socket — rely on the helper. On current code
		// this falls through to the 5s deadline and logs the spurious warn.
		const started = Date.now();
		await closeServerWithDeadline(server, 'test:live-accept', 5_000);
		const elapsed = Date.now() - started;
		expect(elapsed).toBeLessThan(1_000);
		expect(server.listening).toBe(false);
		client.destroy();

		// The listening handle is genuinely released: the port re-binds immediately,
		// so resolving early cannot reintroduce EADDRINUSE on port reuse.
		const rebind = createNetServer();
		await new Promise<void>((resolve, reject) => {
			rebind.once('error', reject);
			rebind.listen(port, '127.0.0.1', () => resolve());
		});
		await new Promise<void>((resolve) => rebind.close(() => resolve()));
	}, 15_000);

	test('resolves within the deadline for a net server with an undrained connection', async () => {
		// Under Node an open accepted socket blocks net.Server.close() until it
		// ends; under Bun close completes immediately. Either way the helper
		// must come back no later than its deadline.
		const server = createNetServer(() => {});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
		const port = (server.address() as AddressInfo).port;

		const client = netConnect({ host: '127.0.0.1', port });
		await new Promise<void>((resolve) => client.on('connect', () => resolve()));

		const started = Date.now();
		await closeServerWithDeadline(server, 'test:net-undrained', 500);
		expect(Date.now() - started).toBeLessThan(2_000);
		client.destroy();
	});
});
