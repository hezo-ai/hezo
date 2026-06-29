import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { closeServerWithDeadline } from '../src/lib/net';

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
