/**
 * Docker's exec output framing, decoded as **bytes**.
 *
 * `services/docker-frames.ts` already decodes this framing, but it decodes to
 * *text* - it exists for the run-log stream, where UTF-8 is the point. A tunnel
 * carries arbitrary binary, and running it through a `TextDecoder` replaces
 * every invalid sequence with U+FFFD, silently corrupting the payload. So the
 * framing is decoded a second time here, deliberately, at the byte level.
 *
 * Format, with `Tty: false`: `[stream u8][0][0][0][len u32be][payload]`, where
 * stream is 1 for stdout and 2 for stderr. (With `Tty: true` Docker sends raw
 * bytes instead, but a TTY also brings line discipline, which would mangle a
 * framed protocol - so the tunnel deliberately runs without one and pays the
 * demux instead.)
 */

const HEADER_BYTES = 8;
const STDOUT = 1;

export interface DockerBinaryFrame {
	stream: 'stdout' | 'stderr';
	payload: Uint8Array;
}

export class DockerBinaryFrameDecoder {
	private buffer: Uint8Array<ArrayBuffer> = new Uint8Array(0);

	/** Feed a chunk; returns every frame it completes, in order. */
	push(chunk: Uint8Array): DockerBinaryFrame[] {
		this.buffer = concat(this.buffer, chunk);
		const out: DockerBinaryFrame[] = [];
		for (;;) {
			if (this.buffer.byteLength < HEADER_BYTES) break;
			const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
			const stream = view.getUint8(0) === STDOUT ? 'stdout' : 'stderr';
			// Unsigned read: a payload above 2^31 would go negative with a shift.
			const length = view.getUint32(4, false);
			const total = HEADER_BYTES + length;
			if (this.buffer.byteLength < total) break;
			out.push({
				stream,
				// Copied, not subarray'd: the buffer is reassigned below and a view
				// into it would alias bytes the next push overwrites.
				payload: this.buffer.slice(HEADER_BYTES, total),
			});
			this.buffer = this.buffer.slice(total);
		}
		return out;
	}

	/** Bytes held from a partial frame - a leak check for the tests. */
	get pending(): number {
		return this.buffer.byteLength;
	}
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(a.byteLength + b.byteLength);
	out.set(a, 0);
	out.set(b, a.byteLength);
	return out;
}
