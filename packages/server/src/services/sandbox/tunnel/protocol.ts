/**
 * The frame protocol carrying tunnelled connections between Hezo and a
 * container.
 *
 * A container needs to reach three things on the Hezo host: the egress proxy,
 * the MCP endpoint (plus signed asset URLs), and the SSH agent. Today all three
 * ride the `host.docker.internal` hostname, which only works because the
 * container is on the same machine. The tunnel replaces that with a multiplexed
 * byte channel that Hezo **dials into** the container, so:
 *
 * - the Hezo instance never has to be reachable from the internet (outbound to
 *   the provider is enough - no public hostname, no inbound port, no NAT
 *   traversal, so an instance on a laptop can drive a remote backend);
 * - there is no tunnel authentication to build, because the channel is already
 *   authenticated and encrypted by the provider API connection (or the Docker
 *   socket locally) - no token to mint, verify, rotate or leak.
 *
 * This module is only the wire format. It is deliberately free of any transport
 * and any IO so it can be tested exhaustively, and so the *same* framing rides
 * whichever byte channel a backend offers - Docker's exec attach, a provider's
 * PTY WebSocket - which is what stops the network stack having two shapes.
 */

/**
 * Where a stream is being opened to.
 *
 * An `OPEN` frame names one of these **keys**, never a host and port. Hezo maps
 * the key to a local address from the run's own allocation, so a compromised
 * agent cannot ask the tunnel to connect somewhere of its choosing - notably
 * anywhere on the operator's LAN. There is no public endpoint to attack either
 * way; this is the second lock.
 */
export const TUNNEL_TARGETS = ['proxy', 'mcp', 'ssh'] as const;
export type TunnelTarget = (typeof TUNNEL_TARGETS)[number];

export function isTunnelTarget(value: string): value is TunnelTarget {
	return (TUNNEL_TARGETS as readonly string[]).includes(value);
}

export enum FrameType {
	/** Container asks Hezo to open a stream to a target key. Payload: the key. */
	Open = 1,
	/** Payload bytes for an open stream, in either direction. */
	Data = 2,
	/** Sender will send no more on this stream. Payload: empty. */
	Close = 3,
	/**
	 * Receiver has consumed `payload` bytes and will accept that many more.
	 *
	 * Backpressure is ours to handle: a provider's channel `write()` buffers
	 * internally, so an ignored return value becomes unbounded buffering on the
	 * Hezo side - the failure AGENTS.md calls out for an ignored `send()`. A
	 * credit window makes a slow reader pause its peer rather than accumulate.
	 */
	Window = 4,
}

/** `[u8 type][u32 streamId][u32 len]`, big-endian. */
export const HEADER_BYTES = 9;

/**
 * Largest payload a single frame may carry.
 *
 * Bounded so a corrupt or hostile length field cannot make the decoder
 * pre-allocate arbitrarily, and so one stream cannot monopolise the shared
 * channel with a single enormous write.
 */
export const MAX_PAYLOAD_BYTES = 64 * 1024;

export interface Frame {
	type: FrameType;
	streamId: number;
	payload: Uint8Array;
}

export function encodeFrame(
	type: FrameType,
	streamId: number,
	payload: Uint8Array = new Uint8Array(0),
): Uint8Array {
	if (payload.byteLength > MAX_PAYLOAD_BYTES) {
		throw new Error(`frame payload ${payload.byteLength} exceeds ${MAX_PAYLOAD_BYTES}`);
	}
	const out = new Uint8Array(HEADER_BYTES + payload.byteLength);
	const view = new DataView(out.buffer);
	view.setUint8(0, type);
	view.setUint32(1, streamId, false);
	view.setUint32(5, payload.byteLength, false);
	out.set(payload, HEADER_BYTES);
	return out;
}

/** `OPEN` carries the target key as UTF-8 - never a host and port (see {@link TUNNEL_TARGETS}). */
export function encodeOpen(streamId: number, target: TunnelTarget): Uint8Array {
	return encodeFrame(FrameType.Open, streamId, new TextEncoder().encode(target));
}

/** A `WINDOW` frame's payload is a single u32 credit count. */
export function windowPayload(credit: number): Uint8Array {
	const payload = new Uint8Array(4);
	new DataView(payload.buffer).setUint32(0, credit, false);
	return payload;
}

export function encodeWindow(streamId: number, credit: number): Uint8Array {
	return encodeFrame(FrameType.Window, streamId, windowPayload(credit));
}

export function decodeWindowCredit(payload: Uint8Array): number {
	if (payload.byteLength !== 4) throw new Error('WINDOW payload must be 4 bytes');
	return new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0, false);
}

/**
 * Incremental frame decoder.
 *
 * A byte channel delivers arbitrary chunks: a frame can arrive split across
 * several reads, and several frames can arrive in one. Anything that assumed
 * chunk boundaries were frame boundaries would work in tests and corrupt under
 * load, so the decoder buffers a partial header or payload and yields only
 * whole frames.
 */
export class FrameDecoder {
	private buffer: Uint8Array<ArrayBuffer> = new Uint8Array(0);

	/**
	 * Feed a chunk; returns every frame it completes.
	 *
	 * Throws on a malformed frame (unknown type, or a length past the cap). The
	 * channel is authenticated end to end, so malformed input means the peer is
	 * broken or the stream desynchronised - in either case continuing to parse
	 * would produce garbage streams rather than recover, so it fails loudly.
	 */
	push(chunk: Uint8Array): Frame[] {
		this.buffer = concat(this.buffer, chunk);
		const frames: Frame[] = [];
		for (;;) {
			if (this.buffer.byteLength < HEADER_BYTES) break;
			const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
			const type = view.getUint8(0);
			const streamId = view.getUint32(1, false);
			const length = view.getUint32(5, false);
			if (length > MAX_PAYLOAD_BYTES) {
				throw new Error(`frame length ${length} exceeds ${MAX_PAYLOAD_BYTES}`);
			}
			if (!isFrameType(type)) throw new Error(`unknown frame type ${type}`);
			const total = HEADER_BYTES + length;
			// Incomplete payload: keep it buffered and wait for the next chunk.
			if (this.buffer.byteLength < total) break;
			frames.push({
				type,
				streamId,
				// Copied rather than subarray'd: the buffer below is reassigned and a
				// view into it would alias bytes the next push overwrites.
				payload: this.buffer.slice(HEADER_BYTES, total),
			});
			this.buffer = this.buffer.slice(total);
		}
		return frames;
	}

	/** Bytes held from a partial frame - a leak check for the tests. */
	get pending(): number {
		return this.buffer.byteLength;
	}
}

function isFrameType(value: number): value is FrameType {
	return (
		value === FrameType.Open ||
		value === FrameType.Data ||
		value === FrameType.Close ||
		value === FrameType.Window
	);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
	// Always a fresh, owned buffer: returning `b` directly would alias a caller's
	// chunk, and the decoder slices its buffer in place.
	const out = new Uint8Array(a.byteLength + b.byteLength);
	out.set(a, 0);
	out.set(b, a.byteLength);
	return out;
}
