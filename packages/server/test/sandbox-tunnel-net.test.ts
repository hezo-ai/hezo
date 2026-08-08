import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
	connectToRunTargets,
	type TargetAddresses,
} from '../src/services/sandbox/tunnel/net-socket';

const servers: Server[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

/** A TCP echo server on an ephemeral port. */
async function echoServer(): Promise<number> {
	const server = createServer((socket) => {
		// `pipe` does not forward errors, so a client that destroys mid-exchange
		// (which the backpressure case does deliberately) leaves an ECONNRESET on
		// this side with no listener - an uncaught exception that fails the whole
		// run, and only under enough load to lose the race.
		socket.on('error', () => {});
		socket.pipe(socket);
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (typeof address === 'string' || address === null) throw new Error('no port');
	return address.port;
}

function addresses(port: number): TargetAddresses {
	const at = { host: '127.0.0.1', port };
	// A closed port for the targets a test is not exercising, so a mistaken
	// connect fails rather than quietly landing on the echo server.
	return { proxy: at, mcp: { host: '127.0.0.1', port: 1 }, ssh: { host: '127.0.0.1', port: 1 } };
}

describe('connectToRunTargets', () => {
	it('connects to the address the key resolves to and carries bytes', async () => {
		const port = await echoServer();
		const socket = await connectToRunTargets(addresses(port))('proxy');

		const received = new Promise<string>((resolve) => {
			socket.onData((chunk) => resolve(new TextDecoder().decode(chunk)));
		});
		socket.write(new TextEncoder().encode('ping'));
		expect(await received).toBe('ping');
		socket.destroy();
	});

	it('rejects rather than resolving a dead socket when the port is closed', async () => {
		// The mux turns a rejection into a CLOSE frame; a resolved-but-dead socket
		// would instead look like an open stream that silently never carries data.
		await expect(connectToRunTargets(addresses(await echoServer()))('mcp')).rejects.toThrow();
	});

	it('reports the end of a peer-closed connection', async () => {
		// `close` is listened for alongside `end` because a reset emits only the
		// former, and a stream that never learned it was gone leaks on both sides.
		const server = createServer((socket) => socket.destroy());
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const address = server.address();
		if (typeof address === 'string' || address === null) throw new Error('no port');

		const socket = await connectToRunTargets(addresses(address.port))('proxy');
		await new Promise<void>((resolve) => {
			socket.onError(() => {});
			socket.onEnd(resolve);
		});
	});

	it('surfaces Node’s backpressure signal unchanged', async () => {
		// That return value *is* the flow control - a wrapper that swallowed it
		// would silently reintroduce unbounded buffering.
		const port = await echoServer();
		const socket = await connectToRunTargets(addresses(port))('proxy');
		expect(typeof socket.write(new TextEncoder().encode('x'))).toBe('boolean');
		socket.destroy();
	});
});
