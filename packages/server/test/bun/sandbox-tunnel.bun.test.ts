import { describe, expect, it } from 'bun:test';
import { createServer, connect as netConnect, type Server } from 'node:net';
import { type ByteChannel, TunnelMux } from '../../src/services/sandbox/tunnel/mux';
import {
	connectToRunTargets,
	nodeTunnelSocket,
} from '../../src/services/sandbox/tunnel/net-socket';
import {
	encodeFrame,
	encodeOpen,
	FrameDecoder,
	FrameType,
	MAX_PAYLOAD_BYTES,
} from '../../src/services/sandbox/tunnel/protocol';

/**
 * The tunnel is `node:net` plus stream handling, and production runs it on Bun
 * while vitest runs under Node - so nothing in the vitest tier says anything
 * about the runtime this actually ships on. The parts most likely to diverge
 * are the ones exercised here: socket backpressure (`write()`'s return value and
 * the `drain` event), `pause`/`resume`, the `end` vs `close` split, and
 * `DataView` over a `Uint8Array` whose buffer is reused.
 */

const servers: Server[] = [];
const text = (s: string) => new TextEncoder().encode(s);
const decode = (p: Uint8Array) => new TextDecoder().decode(p);

async function echoServer(transform: (s: string) => string = (s) => s): Promise<number> {
	const server = createServer((socket) => {
		socket.on('data', (chunk) => socket.end(transform(chunk.toString())));
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (typeof address === 'string' || address === null) throw new Error('no port');
	return address.port;
}

function closeAll(): void {
	for (const server of servers.splice(0)) server.close();
}

describe('tunnel framing under Bun', () => {
	it('decodes a frame split across chunks', () => {
		// DataView over a Uint8Array whose buffer is reassigned each push - the
		// byteOffset handling is the part that could differ between runtimes.
		const wire = encodeFrame(FrameType.Data, 7, text('bun bytes'));
		const decoder = new FrameDecoder();
		const out = [];
		for (const byte of wire) out.push(...decoder.push(new Uint8Array([byte])));
		expect(out.length).toBe(1);
		expect(decode(out[0].payload)).toBe('bun bytes');
		expect(decoder.pending).toBe(0);
	});

	it('carries a full-size binary payload without corruption', () => {
		const big = new Uint8Array(MAX_PAYLOAD_BYTES);
		for (let i = 0; i < big.length; i++) big[i] = i % 256;
		const [frame] = new FrameDecoder().push(encodeFrame(FrameType.Data, 1, big));
		expect(frame.payload.byteLength).toBe(MAX_PAYLOAD_BYTES);
		expect(frame.payload[255]).toBe(255);
		expect(frame.payload[256]).toBe(0);
	});
});

describe('tunnel sockets under Bun', () => {
	it('carries bytes both ways over a real socket', async () => {
		try {
			const port = await echoServer((s) => `bun:${s}`);
			const socket = await connectToRunTargets({
				proxy: { host: '127.0.0.1', port },
				mcp: { host: '127.0.0.1', port },
				ssh: { host: '127.0.0.1', port },
			})('mcp');

			const received = new Promise<string>((resolve) => {
				socket.onData((chunk) => resolve(decode(chunk)));
			});
			socket.write(text('ping'));
			expect(await received).toBe('bun:ping');
			socket.destroy();
		} finally {
			closeAll();
		}
	});

	it('reports the end of a connection the peer reset', async () => {
		// Bun's `net` emits `close` without `end` on a reset, same as Node's - the
		// reason nodeTunnelSocket listens for both. If it did not here, the stream
		// would leak on both sides of the tunnel.
		try {
			const server = createServer((socket) => socket.destroy());
			servers.push(server);
			await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
			const address = server.address();
			if (typeof address === 'string' || address === null) throw new Error('no port');

			const socket = await connectToRunTargets({
				proxy: { host: '127.0.0.1', port: address.port },
				mcp: { host: '127.0.0.1', port: address.port },
				ssh: { host: '127.0.0.1', port: address.port },
			})('proxy');
			await new Promise<void>((resolve) => {
				socket.onError(() => {});
				socket.onEnd(resolve);
			});
		} finally {
			closeAll();
		}
	});

	it('returns a boolean from write, which is the whole flow-control signal', async () => {
		try {
			const port = await echoServer();
			const socket = await connectToRunTargets({
				proxy: { host: '127.0.0.1', port },
				mcp: { host: '127.0.0.1', port },
				ssh: { host: '127.0.0.1', port },
			})('ssh');
			// A runtime that returned undefined here would make the mux treat every
			// write as backpressured and stall the stream permanently.
			expect(typeof socket.write(text('x'))).toBe('boolean');
			socket.destroy();
		} finally {
			closeAll();
		}
	});
});

describe('TunnelMux over Bun sockets', () => {
	it('opens a target, carries a request, and returns the reply', async () => {
		try {
			const port = await echoServer((s) => `echo:${s}`);
			const frames: Uint8Array[] = [];
			const channel: ByteChannel = {
				write: (data) => {
					frames.push(data);
				},
				close: () => {},
			};
			const mux = new TunnelMux(
				channel,
				() =>
					new Promise((resolve, reject) => {
						const socket = netConnect({ host: '127.0.0.1', port });
						socket.once('error', reject);
						socket.once('connect', () => resolve(nodeTunnelSocket(socket)));
					}),
				{ windowBytes: 4096 },
			);

			await mux.handleChunk(encodeOpen(1, 'mcp'));
			await mux.handleChunk(encodeFrame(FrameType.Data, 1, text('hello')));

			// The reply arrives asynchronously from the socket.
			const decoder = new FrameDecoder();
			const deadline = Date.now() + 5000;
			let reply = '';
			while (Date.now() < deadline && !reply) {
				for (const chunk of frames.splice(0)) {
					for (const frame of decoder.push(chunk)) {
						if (frame.type === FrameType.Data) reply += decode(frame.payload);
					}
				}
				if (!reply) await Bun.sleep(20);
			}
			expect(reply).toBe('echo:hello');
			mux.closeAll();
		} finally {
			closeAll();
		}
	});

	it('destroys its sockets on teardown', async () => {
		// An open tunnel keeps a container from going idle - a bill, not an error -
		// so teardown is asserted on the runtime that actually ships.
		try {
			const port = await echoServer();
			let closed = false;
			const mux = new TunnelMux(
				{
					write: () => {},
					close: () => {
						closed = true;
					},
				},
				() =>
					new Promise((resolve, reject) => {
						const socket = netConnect({ host: '127.0.0.1', port });
						socket.once('error', reject);
						socket.once('connect', () => resolve(nodeTunnelSocket(socket)));
					}),
			);
			await mux.handleChunk(encodeOpen(1, 'proxy'));
			expect(mux.openStreams).toBe(1);

			mux.closeAll();
			expect(mux.openStreams).toBe(0);
			expect(closed).toBe(true);
		} finally {
			closeAll();
		}
	});
});
