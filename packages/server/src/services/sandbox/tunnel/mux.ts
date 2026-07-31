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
}

export class TunnelMux {
	private readonly decoder = new FrameDecoder();
	private readonly streams = new Map<number, Stream>();
	private readonly window: number;
	private closed = false;

	constructor(
		private readonly channel: ByteChannel,
		private readonly connect: ConnectTarget,
		opts: { windowBytes?: number } = {},
	) {
		this.window = opts.windowBytes ?? DEFAULT_WINDOW_BYTES;
	}

	/** Feed bytes arriving from the container. */
	async handleChunk(chunk: Uint8Array): Promise<void> {
		if (this.closed) return;
		let frames: ReturnType<FrameDecoder['push']>;
		try {
			frames = this.decoder.push(chunk);
		} catch (e) {
			// A desynchronised stream cannot be recovered by parsing harder: every
			// subsequent frame boundary is wrong, so the streams would silently
			// carry garbage. Tear the tunnel down instead.
			log.error(`tunnel framing error, closing: ${(e as Error).message}`);
			this.closeAll();
			return;
		}
		for (const frame of frames) {
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
	}

	/** Tear down every stream and the channel. Idempotent. */
	closeAll(): void {
		if (this.closed) return;
		this.closed = true;
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
		for (let offset = 0; offset < data.byteLength; offset += MAX_PAYLOAD_BYTES) {
			const slice = data.slice(offset, offset + MAX_PAYLOAD_BYTES);
			this.send(FrameType.Data, streamId, slice);
			stream.credit -= slice.byteLength;
		}
		if (stream.credit <= 0 && !stream.pausedForCredit) {
			stream.pausedForCredit = true;
			stream.socket.pause();
		}
	}

	/** Bytes from the container, headed for our local socket. */
	private onData(streamId: number, payload: Uint8Array): void {
		const stream = this.streams.get(streamId);
		if (!stream || stream.closed) return;
		const accepted = stream.socket.write(payload);
		stream.unacked += payload.byteLength;
		if (!accepted) {
			// Kernel buffer full: withhold credit until drain, so the container
			// stops sending rather than us queueing what we cannot write.
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
		this.channel.write(encodeFrame(type, streamId, payload));
	}
}
