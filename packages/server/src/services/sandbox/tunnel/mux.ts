import { logger } from '../../../logger';
import {
	decodeWindowCredit,
	encodeFrame,
	FrameDecoder,
	FrameType,
	isTunnelTarget,
	MAX_PAYLOAD_BYTES,
	type TunnelTarget,
	windowPayload,
} from './protocol';

const log = logger.child('tunnel-mux');

/**
 * The Hezo-side end of the tunnel: it owns the connections the container asks
 * for and pumps bytes between them and the shared channel.
 *
 * Everything transport-specific is behind {@link ByteChannel}, so the same
 * multiplexer drives Docker's exec attach and a provider's PTY WebSocket - the
 * two backends differ in the channel underneath, never in the framing or the
 * flow control above it.
 */

/** The shared, already-authenticated byte channel to the container. */
export interface ByteChannel {
	write(data: Uint8Array): void;
	close(): void;
}

/**
 * The slice of a socket the multiplexer drives.
 *
 * Narrower than `net.Socket` on purpose: it is exactly what flow control needs,
 * so a test supplies a complete implementation rather than a partial object
 * cast through `unknown` - the failure AGENTS.md calls out, where a stub omits
 * a method until production calls it.
 */
export interface TunnelSocket {
	/** False when the kernel buffer is full - the signal that drives backpressure. */
	write(data: Uint8Array): boolean;
	end(): void;
	destroy(): void;
	pause(): void;
	resume(): void;
	onData(handler: (chunk: Uint8Array) => void): void;
	onEnd(handler: () => void): void;
	onError(handler: (err: Error) => void): void;
	onDrain(handler: () => void): void;
}

/** Opens a connection for a target key. The key is resolved by Hezo, never by the container. */
export type ConnectTarget = (target: TunnelTarget) => Promise<TunnelSocket>;

/**
 * Bytes each side may send before waiting for the peer to acknowledge.
 *
 * This is the whole of the backpressure story, and it exists because a
 * provider's channel `write()` buffers internally: without a window, a fast
 * producer and a slow consumer turn into unbounded buffering on the Hezo side -
 * the ignored-`send()`-result failure AGENTS.md names. Large enough that a
 * normal transfer never stalls on a round trip, small enough that a stalled
 * stream cannot hold much.
 */
const DEFAULT_WINDOW_BYTES = 256 * 1024;

interface Stream {
	socket: TunnelSocket;
	/** Bytes we may still send to the container before it credits us more. */
	credit: number;
	/** Set while the socket is paused waiting on credit, so a WINDOW resumes it. */
	pausedForCredit: boolean;
	/** Set while our local socket's buffer is full, so we withhold credit from the peer. */
	awaitingDrain: boolean;
	/** Bytes consumed since the last WINDOW we sent, batched to avoid a frame per chunk. */
	unacked: number;
	closed: boolean;
	/** When the stream first became unable to move bytes, or null while it can. */
	blockedSince: number | null;
	/** Set once the watchdog has reported this block, so it reports it once. */
	blockReported: boolean;
}

/**
 * How long a stream may hold bytes it cannot move before the tunnel says so.
 *
 * Chosen below git's own low-speed floor (`GIT_HTTP_LOW_SPEED_TIME`, 30s in
 * git-executor.ts) so a stalled clone is diagnosed here *before* git abandons
 * it. Otherwise the only artifact is git's `curl 28`, which names the symptom
 * and not one thing about where the bytes stopped.
 */
const STALL_WARN_MS = 20_000;

/** How often to look for a blocked stream. Cheap: it walks the open streams of
 * one run, and a run holds a handful. */
const STALL_SCAN_MS = 5_000;

/**
 * Counters for what actually crossed the channel.
 *
 * Always collected and never logged on their own - they exist so a test can
 * assert reconciliation (`payloadBytesIn + 9·framesIn + decoderPending` should
 * account for every byte the channel delivered) and so an anomaly report can
 * carry the totals that make it interpretable. Stalls are counted rather than
 * warned about: flow control engaging is normal, and only its *duration* is a
 * fault.
 */
export interface TunnelMuxStats {
	framesIn: number;
	framesOut: number;
	payloadBytesIn: number;
	payloadBytesOut: number;
	/** Bytes written to local sockets, i.e. delivered towards the host. */
	socketBytesIn: number;
	/** Bytes read from local sockets, i.e. headed for the container. */
	socketBytesOut: number;
	creditStalls: number;
	drainStalls: number;
	decoderPending: number;
	openStreams: number;
}

export class TunnelMux {
	// Expects the client's preamble: a byte channel is not always clean from byte
	// zero (a PTY carries a shell's echo and prompt), and everything before the
	// marker is noise to discard rather than frames to parse.
	private readonly decoder = new FrameDecoder({ expectPreamble: true });
	private readonly streams = new Map<number, Stream>();
	private readonly window: number;
	private closed = false;
	/** Serializes handleChunk so frames are processed strictly in arrival order. */
	private queue: Promise<void> = Promise.resolve();
	private readonly counters = {
		framesIn: 0,
		framesOut: 0,
		payloadBytesIn: 0,
		payloadBytesOut: 0,
		socketBytesIn: 0,
		socketBytesOut: 0,
		creditStalls: 0,
		drainStalls: 0,
	};
	private readonly stallScan: ReturnType<typeof setInterval>;

	constructor(
		private readonly channel: ByteChannel,
		private readonly connect: ConnectTarget,
		opts: { windowBytes?: number } = {},
	) {
		this.window = opts.windowBytes ?? DEFAULT_WINDOW_BYTES;
		this.stallScan = setInterval(() => this.reportStalledStreams(), STALL_SCAN_MS);
		// Never the reason a process stays up; the tunnel's own lifetime bounds it.
		this.stallScan.unref?.();
	}

	get stats(): TunnelMuxStats {
		return {
			...this.counters,
			decoderPending: this.decoder.pending,
			openStreams: this.streams.size,
		};
	}

	/**
	 * Report a stream that has held bytes it cannot move for too long.
	 *
	 * The predicate is deliberately "we have bytes and cannot move them", never
	 * "no traffic": a tunnel carries zero bytes for minutes at a time while an
	 * agent thinks, and that is healthy. Blocked-on-flow-control for twenty
	 * seconds never is - the peer has either stopped reading or stopped
	 * acknowledging, and both are invisible from the far end.
	 */
	private reportStalledStreams(): void {
		if (this.closed) return;
		const now = Date.now();
		for (const [streamId, stream] of this.streams) {
			const blocked = stream.pausedForCredit || stream.awaitingDrain;
			if (!blocked) {
				stream.blockedSince = null;
				stream.blockReported = false;
				continue;
			}
			if (stream.blockedSince === null) {
				stream.blockedSince = now;
				continue;
			}
			if (stream.blockReported || now - stream.blockedSince < STALL_WARN_MS) continue;
			stream.blockReported = true;
			const why = stream.pausedForCredit ? 'awaiting credit from the container' : 'awaiting drain';
			log.warn(
				`tunnel stream ${streamId} has been blocked for ${Math.round((now - stream.blockedSince) / 1000)}s ` +
					`(${why}; credit=${stream.credit}, unacked=${stream.unacked}); ` +
					`channel totals ${JSON.stringify(this.stats)}`,
			);
		}
	}

	/**
	 * Feed bytes arriving from the container.
	 *
	 * Serialized against itself, and that is load-bearing rather than tidiness:
	 * `onOpen` awaits a real connect, so without this a DATA frame arriving in a
	 * later chunk would be processed while its OPEN was still connecting, find no
	 * stream registered, and be **silently dropped**. The first bytes of a
	 * connection are exactly the ones that arrive that way, so the symptom is a
	 * stream that hangs having lost its request.
	 */
	handleChunk(chunk: Uint8Array): Promise<void> {
		this.queue = this.queue.then(() => this.process(chunk));
		return this.queue;
	}

	private async process(chunk: Uint8Array): Promise<void> {
		if (this.closed) return;
		// The whole body, not just the decode. A throw anywhere in the dispatch
		// below - `decodeWindowCredit` on a WINDOW frame whose payload is not four
		// bytes is the reachable one, and the threat model assumes the container may
		// misbehave - would otherwise reject `this.queue`, after which every later
		// `queue.then(...)` is skipped: the tunnel silently stops reading, wedged
		// rather than closed, with an unhandled rejection to show for it. Failing
		// closed is the only honest response to a stream we can no longer trust.
		try {
			const frames = this.decoder.push(chunk);
			for (const frame of frames) {
				this.counters.framesIn += 1;
				this.counters.payloadBytesIn += frame.payload.byteLength;
				switch (frame.type) {
					case FrameType.Open:
						await this.onOpen(frame.streamId, new TextDecoder().decode(frame.payload));
						break;
					case FrameType.Data:
						this.onData(frame.streamId, frame.payload);
						break;
					case FrameType.Close:
						this.onRemoteClose(frame.streamId);
						break;
					case FrameType.Window:
						this.onWindow(frame.streamId, decodeWindowCredit(frame.payload));
						break;
				}
			}
		} catch (e) {
			// A desynchronised stream cannot be recovered by parsing harder: every
			// subsequent frame boundary is wrong, so the streams would silently
			// carry garbage. Tear the tunnel down instead.
			// The bytes at the desync point are the whole diagnosis, so they go in
			// the message: `ef bf bd` runs mean something re-encoded the binary
			// stream as text, while plausible payload bytes mean a header was read
			// at the wrong offset because bytes went missing.
			const head = Buffer.from(this.decoder.peek(16)).toString('hex').replace(/(..)/g, '$1 ');
			log.error(
				`tunnel framing error, closing: ${(e as Error).message}; ` +
					`next bytes [${head.trim()}]; channel totals ${JSON.stringify(this.stats)}`,
			);
			this.closeAll();
		}
	}

	/** Tear down every stream and the channel. Idempotent. */
	closeAll(): void {
		if (this.closed) return;
		this.closed = true;
		clearInterval(this.stallScan);
		// A partial frame at close means the channel stopped mid-frame: the peer
		// died holding bytes, or something below us truncated the stream. Either
		// way the streams above lost their tail, which is silent from up there.
		if (this.decoder.pending > 0) {
			log.warn(
				`tunnel channel closed holding ${this.decoder.pending} byte(s) of a partial frame; ` +
					`channel totals ${JSON.stringify(this.stats)}`,
			);
		}
		for (const stream of this.streams.values()) stream.socket.destroy();
		this.streams.clear();
		this.channel.close();
	}

	get openStreams(): number {
		return this.streams.size;
	}

	private async onOpen(streamId: number, targetKey: string): Promise<void> {
		if (this.streams.has(streamId)) {
			log.warn(`tunnel OPEN for existing stream ${streamId}, ignoring`);
			return;
		}
		// The container names a key, and Hezo resolves it. A key it does not
		// recognise is refused rather than interpreted - this is what stops an
		// OPEN from naming an arbitrary host and port.
		if (!isTunnelTarget(targetKey)) {
			log.warn(`tunnel OPEN for unknown target ${JSON.stringify(targetKey)}, refusing`);
			this.send(FrameType.Close, streamId);
			return;
		}

		let socket: TunnelSocket;
		try {
			socket = await this.connect(targetKey);
		} catch (e) {
			log.warn(`tunnel connect to ${targetKey} failed: ${(e as Error).message}`);
			this.send(FrameType.Close, streamId);
			return;
		}
		// Raced with a teardown while connecting.
		if (this.closed) {
			socket.destroy();
			return;
		}

		const stream: Stream = {
			socket,
			credit: this.window,
			pausedForCredit: false,
			awaitingDrain: false,
			unacked: 0,
			closed: false,
			blockedSince: null,
			blockReported: false,
		};
		this.streams.set(streamId, stream);

		socket.onData((data) => this.onLocalData(streamId, stream, data));
		socket.onEnd(() => this.onLocalEnd(streamId, stream));
		socket.onError(() => this.onLocalEnd(streamId, stream));
		socket.onDrain(() => {
			// Our socket drained, so we can accept more from the container.
			stream.awaitingDrain = false;
			this.flushCredit(streamId, stream);
		});
		// Tell the container how much it may send before hearing from us again.
		this.send(FrameType.Window, streamId, windowPayload(this.window));
	}

	/**
	 * Bytes from our local socket, headed for the container.
	 *
	 * Split to the frame cap and metered against the peer's credit; when credit
	 * runs out the socket is **paused** rather than the remainder buffered here,
	 * which is what keeps the memory bound on the producing side.
	 */
	private onLocalData(streamId: number, stream: Stream, data: Uint8Array): void {
		if (stream.closed) return;
		this.counters.socketBytesOut += data.byteLength;
		for (let offset = 0; offset < data.byteLength; offset += MAX_PAYLOAD_BYTES) {
			const slice = data.slice(offset, offset + MAX_PAYLOAD_BYTES);
			this.send(FrameType.Data, streamId, slice);
			stream.credit -= slice.byteLength;
		}
		if (stream.credit <= 0 && !stream.pausedForCredit) {
			stream.pausedForCredit = true;
			this.counters.creditStalls += 1;
			stream.socket.pause();
		}
	}

	/** Bytes from the container, headed for our local socket. */
	private onData(streamId: number, payload: Uint8Array): void {
		const stream = this.streams.get(streamId);
		if (!stream || stream.closed) return;
		const accepted = stream.socket.write(payload);
		this.counters.socketBytesIn += payload.byteLength;
		stream.unacked += payload.byteLength;
		if (!accepted) {
			// Kernel buffer full: withhold credit until drain, so the container
			// stops sending rather than us queueing what we cannot write.
			if (!stream.awaitingDrain) this.counters.drainStalls += 1;
			stream.awaitingDrain = true;
			return;
		}
		this.flushCredit(streamId, stream);
	}

	/**
	 * Return consumed bytes as credit, batched.
	 *
	 * Batched at half the window because a WINDOW frame per DATA frame would
	 * double the frame count on the shared channel for no gain, while waiting
	 * for the full window would stall the peer at exactly the wrong moment.
	 */
	private flushCredit(streamId: number, stream: Stream): void {
		if (stream.awaitingDrain || stream.closed) return;
		if (stream.unacked < this.window / 2) return;
		this.send(FrameType.Window, streamId, windowPayload(stream.unacked));
		stream.unacked = 0;
	}

	private onWindow(streamId: number, credit: number): void {
		const stream = this.streams.get(streamId);
		if (!stream || stream.closed) return;
		stream.credit += credit;
		if (stream.pausedForCredit && stream.credit > 0) {
			stream.pausedForCredit = false;
			stream.socket.resume();
		}
	}

	private onRemoteClose(streamId: number): void {
		const stream = this.streams.get(streamId);
		if (!stream) return;
		stream.closed = true;
		// A socket paused for credit is not reading, so it would never observe its
		// peer's FIN and never emit `close` - the descriptor and its per-host port
		// would then survive until the whole proxy is torn down. Nothing more is
		// coming for it, so the reason it was paused is gone.
		if (stream.pausedForCredit) {
			stream.pausedForCredit = false;
			stream.socket.resume();
		}
		stream.socket.end();
		this.streams.delete(streamId);
	}

	private onLocalEnd(streamId: number, stream: Stream): void {
		if (stream.closed) return;
		stream.closed = true;
		this.streams.delete(streamId);
		this.send(FrameType.Close, streamId);
	}

	private send(type: FrameType, streamId: number, payload?: Uint8Array): void {
		if (this.closed) return;
		this.counters.framesOut += 1;
		this.counters.payloadBytesOut += payload?.byteLength ?? 0;
		this.channel.write(encodeFrame(type, streamId, payload));
	}
}
