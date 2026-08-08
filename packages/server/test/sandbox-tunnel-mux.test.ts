import { describe, expect, it } from 'vitest';
import { type ByteChannel, TunnelMux, type TunnelSocket } from '../src/services/sandbox/tunnel/mux';
import {
	decodeWindowCredit,
	encodeFrame,
	encodeOpen,
	encodeWindow,
	type Frame,
	FrameDecoder,
	FrameType,
	MAX_PAYLOAD_BYTES,
	TUNNEL_PREAMBLE,
	type TunnelTarget,
} from '../src/services/sandbox/tunnel/protocol';

const text = (s: string) => new TextEncoder().encode(s);
const decode = (p: Uint8Array) => new TextDecoder().decode(p);

/** Captures everything the mux writes back to the container, already decoded. */
function recordingChannel() {
	const frames: Frame[] = [];
	const decoder = new FrameDecoder();
	let closed = false;
	const channel: ByteChannel = {
		write: (data) => frames.push(...decoder.push(data)),
		close: () => {
			closed = true;
		},
	};
	return {
		channel,
		frames,
		get closed() {
			return closed;
		},
		ofType: (type: FrameType) => frames.filter((f) => f.type === type),
	};
}

/**
 * A complete {@link TunnelSocket}, not a partial object cast into place.
 * `acceptWrites: false` models a full kernel buffer, which is the whole point
 * of the backpressure tests.
 */
function fakeSocket(opts: { acceptWrites?: boolean } = {}) {
	const written: Uint8Array[] = [];
	const handlers: {
		data?: (c: Uint8Array) => void;
		end?: () => void;
		error?: (e: Error) => void;
		drain?: () => void;
	} = {};
	const state = {
		paused: false,
		ended: false,
		destroyed: false,
		accept: opts.acceptWrites ?? true,
	};
	const socket: TunnelSocket = {
		write: (data) => {
			written.push(data);
			return state.accept;
		},
		end: () => {
			state.ended = true;
		},
		destroy: () => {
			state.destroyed = true;
		},
		pause: () => {
			state.paused = true;
		},
		resume: () => {
			state.paused = false;
		},
		onData: (h) => {
			handlers.data = h;
		},
		onEnd: (h) => {
			handlers.end = h;
		},
		onError: (h) => {
			handlers.error = h;
		},
		onDrain: (h) => {
			handlers.drain = h;
		},
	};
	return { socket, written, handlers, state };
}

const WINDOW = 1024;

async function open(
	mux: TunnelMux,
	streamId: number,
	target: TunnelTarget = 'proxy',
): Promise<void> {
	await mux.handleChunk(encodeOpen(streamId, target));
}

/**
 * A mux that has already consumed the client's preamble, which is the state
 * production is always in by the time frames flow. Feeding it here rather than
 * switching the expectation off keeps the real handshake under test.
 */
function syncedMux(...args: ConstructorParameters<typeof TunnelMux>): TunnelMux {
	const mux = new TunnelMux(...args);
	void mux.handleChunk(TUNNEL_PREAMBLE);
	return mux;
}

describe('TunnelMux stream lifecycle', () => {
	it('opens a connection for a known target key and credits the peer', async () => {
		const rec = recordingChannel();
		const sock = fakeSocket();
		const targets: TunnelTarget[] = [];
		const mux = syncedMux(
			rec.channel,
			async (t) => {
				targets.push(t);
				return sock.socket;
			},
			{ windowBytes: WINDOW },
		);

		await open(mux, 1, 'mcp');
		expect(targets).toEqual(['mcp']);
		expect(mux.openStreams).toBe(1);
		const [window] = rec.ofType(FrameType.Window);
		expect(decodeWindowCredit(window.payload)).toBe(WINDOW);
	});

	it('refuses an OPEN naming anything but a known key, and opens nothing', async () => {
		// The security property: an OPEN names a key Hezo resolves, never a host
		// and port, so a compromised agent cannot reach the operator's LAN.
		const rec = recordingChannel();
		let connects = 0;
		const mux = syncedMux(
			rec.channel,
			async () => {
				connects++;
				return fakeSocket().socket;
			},
			{ windowBytes: WINDOW },
		);

		for (const hostile of ['127.0.0.1:22', '192.168.1.1:80', 'proxy\u0000', 'PROXY', '']) {
			await mux.handleChunk(encodeFrame(FrameType.Open, 1, text(hostile)));
		}
		expect(connects).toBe(0);
		expect(mux.openStreams).toBe(0);
		expect(rec.ofType(FrameType.Close)).toHaveLength(5);
	});

	it('closes the stream when the connection cannot be made', async () => {
		const rec = recordingChannel();
		const mux = syncedMux(rec.channel, async () => {
			throw new Error('ECONNREFUSED');
		});
		await open(mux, 1);
		expect(mux.openStreams).toBe(0);
		expect(rec.ofType(FrameType.Close)).toHaveLength(1);
	});

	it('forwards container bytes to the socket', async () => {
		const rec = recordingChannel();
		const sock = fakeSocket();
		const mux = syncedMux(rec.channel, async () => sock.socket, { windowBytes: WINDOW });
		await open(mux, 1);
		await mux.handleChunk(encodeFrame(FrameType.Data, 1, text('GET / HTTP/1.1')));
		expect(sock.written.map(decode)).toEqual(['GET / HTTP/1.1']);
	});

	it('forwards socket bytes to the container', async () => {
		const rec = recordingChannel();
		const sock = fakeSocket();
		const mux = syncedMux(rec.channel, async () => sock.socket, { windowBytes: WINDOW });
		await open(mux, 1);
		sock.handlers.data?.(text('HTTP/1.1 200 OK'));
		expect(rec.ofType(FrameType.Data).map((f) => decode(f.payload))).toEqual(['HTTP/1.1 200 OK']);
	});

	it('ends the socket on a remote close and forgets the stream', async () => {
		const rec = recordingChannel();
		const sock = fakeSocket();
		const mux = syncedMux(rec.channel, async () => sock.socket, { windowBytes: WINDOW });
		await open(mux, 1);
		await mux.handleChunk(encodeFrame(FrameType.Close, 1));
		expect(sock.state.ended).toBe(true);
		expect(mux.openStreams).toBe(0);
	});

	it('tells the container when the local socket ends', async () => {
		const rec = recordingChannel();
		const sock = fakeSocket();
		const mux = syncedMux(rec.channel, async () => sock.socket, { windowBytes: WINDOW });
		await open(mux, 1);
		sock.handlers.end?.();
		expect(rec.ofType(FrameType.Close)).toHaveLength(1);
		expect(mux.openStreams).toBe(0);
	});

	it('treats a socket error as a close rather than leaking the stream', async () => {
		const rec = recordingChannel();
		const sock = fakeSocket();
		const mux = syncedMux(rec.channel, async () => sock.socket, { windowBytes: WINDOW });
		await open(mux, 1);
		sock.handlers.error?.(new Error('ECONNRESET'));
		expect(mux.openStreams).toBe(0);
		expect(rec.ofType(FrameType.Close)).toHaveLength(1);
	});

	it('multiplexes independent streams', async () => {
		const rec = recordingChannel();
		const sockets = [fakeSocket(), fakeSocket()];
		let n = 0;
		const mux = syncedMux(rec.channel, async () => sockets[n++].socket, {
			windowBytes: WINDOW,
		});
		await open(mux, 1, 'proxy');
		await open(mux, 2, 'ssh');
		await mux.handleChunk(encodeFrame(FrameType.Data, 2, text('for-two')));
		expect(sockets[0].written).toHaveLength(0);
		expect(sockets[1].written.map(decode)).toEqual(['for-two']);
	});

	it('ignores data for a stream that is gone', async () => {
		const rec = recordingChannel();
		const mux = syncedMux(rec.channel, async () => fakeSocket().socket);
		await expect(
			mux.handleChunk(encodeFrame(FrameType.Data, 99, text('nobody home'))),
		).resolves.toBeUndefined();
	});
});

/**
 * Backpressure is ours to get right: a provider's channel `write()` buffers
 * internally, so without a credit window a fast producer and a slow consumer
 * become unbounded buffering on the Hezo side.
 */
describe('TunnelMux backpressure', () => {
	it('pauses the socket once the peer’s credit is exhausted', async () => {
		const rec = recordingChannel();
		const sock = fakeSocket();
		const mux = syncedMux(rec.channel, async () => sock.socket, { windowBytes: WINDOW });
		await open(mux, 1);

		sock.handlers.data?.(new Uint8Array(WINDOW));
		expect(sock.state.paused).toBe(true);
	});

	it('resumes the socket when the peer credits more', async () => {
		const rec = recordingChannel();
		const sock = fakeSocket();
		const mux = syncedMux(rec.channel, async () => sock.socket, { windowBytes: WINDOW });
		await open(mux, 1);
		sock.handlers.data?.(new Uint8Array(WINDOW));
		expect(sock.state.paused).toBe(true);

		await mux.handleChunk(encodeWindow(1, WINDOW));
		expect(sock.state.paused).toBe(false);
	});

	it('withholds credit while the local socket is backed up, and releases it on drain', async () => {
		// The mirror direction: a slow local socket must stop the container
		// sending rather than have us queue what we cannot write.
		const rec = recordingChannel();
		const sock = fakeSocket({ acceptWrites: false });
		const mux = syncedMux(rec.channel, async () => sock.socket, { windowBytes: WINDOW });
		await open(mux, 1);
		const creditsBefore = rec.ofType(FrameType.Window).length;

		await mux.handleChunk(encodeFrame(FrameType.Data, 1, new Uint8Array(WINDOW)));
		expect(rec.ofType(FrameType.Window)).toHaveLength(creditsBefore);

		sock.state.accept = true;
		sock.handlers.drain?.();
		expect(rec.ofType(FrameType.Window).length).toBeGreaterThan(creditsBefore);
	});

	it('batches credit rather than acking every frame', async () => {
		const rec = recordingChannel();
		const sock = fakeSocket();
		const mux = syncedMux(rec.channel, async () => sock.socket, { windowBytes: WINDOW });
		await open(mux, 1);
		const before = rec.ofType(FrameType.Window).length;

		// Well under half the window: acking each one would double the frame
		// count on the shared channel for no gain.
		for (let i = 0; i < 4; i++) {
			await mux.handleChunk(encodeFrame(FrameType.Data, 1, new Uint8Array(16)));
		}
		expect(rec.ofType(FrameType.Window)).toHaveLength(before);

		await mux.handleChunk(encodeFrame(FrameType.Data, 1, new Uint8Array(WINDOW / 2)));
		expect(rec.ofType(FrameType.Window).length).toBeGreaterThan(before);
	});

	it('splits a socket read larger than the frame cap', async () => {
		const rec = recordingChannel();
		const sock = fakeSocket();
		const mux = syncedMux(rec.channel, async () => sock.socket, {
			windowBytes: 4 * MAX_PAYLOAD_BYTES,
		});
		await open(mux, 1);
		sock.handlers.data?.(new Uint8Array(MAX_PAYLOAD_BYTES * 2 + 10));

		const data = rec.ofType(FrameType.Data);
		expect(data).toHaveLength(3);
		expect(data.map((f) => f.payload.byteLength)).toEqual([
			MAX_PAYLOAD_BYTES,
			MAX_PAYLOAD_BYTES,
			10,
		]);
	});
});

describe('TunnelMux teardown', () => {
	it('destroys every open socket and closes the channel', async () => {
		// An open tunnel prevents a container from ever going idle, which shows up
		// as a bill rather than an error - so teardown is asserted, not trusted.
		const rec = recordingChannel();
		const sockets = [fakeSocket(), fakeSocket()];
		let n = 0;
		const mux = syncedMux(rec.channel, async () => sockets[n++].socket);
		await open(mux, 1);
		await open(mux, 2);

		mux.closeAll();
		expect(sockets.every((s) => s.state.destroyed)).toBe(true);
		expect(mux.openStreams).toBe(0);
		expect(rec.closed).toBe(true);
	});

	it('is idempotent', async () => {
		const rec = recordingChannel();
		const mux = syncedMux(rec.channel, async () => fakeSocket().socket);
		mux.closeAll();
		expect(() => mux.closeAll()).not.toThrow();
	});

	it('accepts no further frames once closed', async () => {
		const rec = recordingChannel();
		let connects = 0;
		const mux = syncedMux(rec.channel, async () => {
			connects++;
			return fakeSocket().socket;
		});
		mux.closeAll();
		await open(mux, 1);
		expect(connects).toBe(0);
	});

	it('tears down on a framing error rather than parsing on', async () => {
		// A desynchronised stream cannot be recovered by parsing harder - every
		// later frame boundary is wrong, so the streams would carry garbage.
		const rec = recordingChannel();
		const mux = syncedMux(rec.channel, async () => fakeSocket().socket);
		await mux.handleChunk(new Uint8Array([99, 0, 0, 0, 1, 0, 0, 0, 0]));
		expect(rec.closed).toBe(true);
	});

	it('destroys a socket that finished connecting after teardown', async () => {
		// The race that would otherwise strand a connection and keep the container
		// alive after the run ended. `entered` makes the connect genuinely
		// in-flight before teardown - without it the queued OPEN is simply never
		// processed, which is a different (and already-covered) path.
		const rec = recordingChannel();
		const sock = fakeSocket();
		let markEntered: (() => void) | undefined;
		const entered = new Promise<void>((r) => {
			markEntered = r;
		});
		let release: (() => void) | undefined;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const mux = syncedMux(rec.channel, async () => {
			markEntered?.();
			await gate;
			return sock.socket;
		});

		const opening = open(mux, 1);
		await entered;
		mux.closeAll();
		release?.();
		await opening;
		expect(sock.state.destroyed).toBe(true);
		expect(mux.openStreams).toBe(0);
	});

	it('never starts a connection for a frame queued behind a teardown', async () => {
		const rec = recordingChannel();
		let connects = 0;
		const mux = syncedMux(rec.channel, async () => {
			connects++;
			return fakeSocket().socket;
		});
		const opening = open(mux, 1);
		mux.closeAll();
		await opening;
		expect(connects).toBe(0);
	});
});
