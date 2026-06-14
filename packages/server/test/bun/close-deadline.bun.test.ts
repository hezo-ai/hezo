import { describe, expect, test } from 'bun:test';
import { createServer as createHttpServer } from 'node:http';
import { type AddressInfo, createServer as createNetServer, connect as netConnect } from 'node:net';
import { closeServerWithDeadline } from '../../src/lib/net';

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
