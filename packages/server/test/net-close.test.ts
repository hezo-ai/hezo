import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer as createNetServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { closeServerWithDeadline, ListenTimeoutError, listenWithDeadline } from '../src/lib/net';

describe('closeServerWithDeadline', () => {
	it('resolves once an idle http server stops listening', async () => {
		const server = createHttpServer();
		await new Promise<void>((resolve) => server.listen(0, resolve));
		expect(server.listening).toBe(true);
		await closeServerWithDeadline(server, 'http-test');
		expect(server.listening).toBe(false);
	});

	it('resolves for a net server with no closeAllConnections', async () => {
		const server = createNetServer();
		await new Promise<void>((resolve) => server.listen(0, resolve));
		await closeServerWithDeadline(server, 'net-test');
		expect(server.listening).toBe(false);
	});

	it('warns and resolves when the close never completes before the deadline', async () => {
		// A bare object whose close() never invokes its callback and which stays
		// "listening" forces the deadline-timeout branch (timedOut → warn → resolve).
		let listening = true;
		const fake = {
			get listening() {
				return listening;
			},
			close() {
				// never call the callback, never stop listening
			},
		};
		const fakeServer = fake as unknown as Parameters<typeof closeServerWithDeadline>[0];
		await expect(closeServerWithDeadline(fakeServer, 'wedged', 40)).resolves.toBeUndefined();
		listening = false;
	});
});

// `listen()` settles on its callback or an `error` event, and a bind that does
// neither hung the caller with nothing to time it out. On the run path that call
// sits inside the window holding a container and the provider credential.
describe('listenWithDeadline', () => {
	it('resolves once the server is bound', async () => {
		const server = createNetServer();
		await listenWithDeadline(server, 'test', (onListening) => server.listen(0, onListening));
		expect(server.listening).toBe(true);
		await closeServerWithDeadline(server, 'test');
	});

	it('rejects with the bind error rather than waiting out the deadline', async () => {
		const taken = createNetServer();
		await listenWithDeadline(taken, 'taken', (onListening) => taken.listen(0, onListening));
		const port = (taken.address() as AddressInfo).port;

		const clash = createNetServer();
		await expect(
			listenWithDeadline(clash, 'clash', (onListening) => clash.listen(port, onListening)),
		).rejects.toThrow(/EADDRINUSE/);

		await closeServerWithDeadline(taken, 'taken');
	});

	it('gives up on a bind that neither binds nor errors', async () => {
		const server = createNetServer();
		// Never calls listen at all: the shape of a bind wedged in the runtime,
		// which previously left the promise unsettled forever.
		await expect(listenWithDeadline(server, 'wedged', () => {}, 30)).rejects.toBeInstanceOf(
			ListenTimeoutError,
		);
		expect(server.listening).toBe(false);
	});
});
