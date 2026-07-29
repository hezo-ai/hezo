import { stripNulBytes } from '../lib/sql';

export type DockerStream = 'stdout' | 'stderr';

export interface DockerFrame {
	stream: DockerStream;
	text: string;
}

/** Docker's multiplexed-stream header: 1 type byte, 3 reserved, 4-byte BE length. */
const HEADER_BYTES = 8;
const INITIAL_CAPACITY = 64 * 1024;

function nextCapacity(needed: number): number {
	let capacity = INITIAL_CAPACITY;
	while (capacity < needed) capacity *= 2;
	return capacity;
}

/**
 * Incremental reader for Docker's multiplexed attach/log stream, shared by the
 * exec transport (`docker.ts`) and the container-log follower
 * (`container-logs.ts`) so the framing lives in one place.
 *
 * Reassembly is offset-based rather than reallocating the pending buffer on
 * every read. The naive form both call sites used —
 * `new Uint8Array(pending + chunk)` on each socket read, then
 * `buffer.slice(8 + size)` on each frame — copies the whole remainder twice per
 * frame, which is O(pending) work on the hottest data path in the system (every
 * agent run and every followed container log). Here consumed bytes are dropped
 * by advancing `start`, and the backing buffer is compacted in place only when
 * it actually needs the room.
 *
 * Decoding is per-stream and incremental (`TextDecoder` with `stream: true`).
 * Frame boundaries land mid-codepoint on arbitrary container output, so a
 * per-frame `decode()` corrupts any multi-byte character that straddles one —
 * the same failure `linesOfGzipFile` avoids with `StringDecoder` on the backup
 * path. stdout and stderr get their own decoder because their frames interleave
 * and a shared one would carry a partial sequence across streams.
 */
export class DockerFrameDecoder {
	private buf = new Uint8Array(INITIAL_CAPACITY);
	/** First unconsumed byte. */
	private start = 0;
	/** One past the last written byte. */
	private end = 0;
	private readonly decoders: Record<DockerStream, TextDecoder> = {
		stdout: new TextDecoder(),
		stderr: new TextDecoder(),
	};

	push(chunk: Uint8Array): void {
		if (chunk.length === 0) return;
		this.ensureRoom(chunk.length);
		this.buf.set(chunk, this.end);
		this.end += chunk.length;
	}

	/**
	 * The next frame carrying content, or `null` when the pending bytes are a
	 * partial frame. Call in a loop after each `push`.
	 *
	 * Frames that decode to nothing are consumed and skipped rather than
	 * returned: a frame ending mid-codepoint leaves its bytes inside the
	 * streaming decoder, and an empty frame is only work for every consumer.
	 */
	next(): DockerFrame | null {
		for (;;) {
			if (this.end - this.start < HEADER_BYTES) return null;
			const head = this.start;
			// Unsigned: a plain `<< 24` goes negative past 2^31. Docker frames never
			// get near that, but a negative size would silently wedge the loop.
			const size =
				((this.buf[head + 4] << 24) >>> 0) +
				(this.buf[head + 5] << 16) +
				(this.buf[head + 6] << 8) +
				this.buf[head + 7];
			if (this.end - this.start < HEADER_BYTES + size) return null;

			const stream: DockerStream = this.buf[head] === 2 ? 'stderr' : 'stdout';
			// A copy, not a subarray: the next `push` may compact the backing buffer,
			// and handing callers a view into it would be a use-after-free in slow
			// motion. Frames are small (Docker caps them well under the buffer size).
			const payload = this.buf.slice(head + HEADER_BYTES, head + HEADER_BYTES + size);
			this.start += HEADER_BYTES + size;
			if (this.start === this.end) {
				this.start = 0;
				this.end = 0;
			}

			const text = stripNulBytes(this.decoders[stream].decode(payload, { stream: true }));
			if (text.length > 0) return { stream, text };
		}
	}

	/**
	 * Flush any bytes a streaming decoder is still holding (a trailing partial
	 * codepoint). Call once when the stream ends; returns only non-empty frames.
	 */
	flush(): DockerFrame[] {
		const out: DockerFrame[] = [];
		for (const stream of ['stdout', 'stderr'] as const) {
			const text = stripNulBytes(this.decoders[stream].decode());
			if (text.length > 0) out.push({ stream, text });
		}
		return out;
	}

	private ensureRoom(incoming: number): void {
		if (this.end + incoming <= this.buf.length) return;
		const pending = this.end - this.start;
		if (pending + incoming <= this.buf.length) {
			this.buf.copyWithin(0, this.start, this.end);
		} else {
			const grown = new Uint8Array(nextCapacity(pending + incoming));
			grown.set(this.buf.subarray(this.start, this.end));
			this.buf = grown;
		}
		this.start = 0;
		this.end = pending;
	}
}

/**
 * Demultiplex a fully-buffered multiplexed stream into its two sides. Used by
 * the non-streaming `execStart` path, whose callers are all small, bounded
 * commands (process scans, git plumbing, preflight probes).
 */
export function demuxDockerStream(raw: Uint8Array): { stdout: string; stderr: string } {
	const decoder = new DockerFrameDecoder();
	decoder.push(raw);
	const parts: Record<DockerStream, string[]> = { stdout: [], stderr: [] };
	for (let frame = decoder.next(); frame !== null; frame = decoder.next()) {
		parts[frame.stream].push(frame.text);
	}
	for (const frame of decoder.flush()) parts[frame.stream].push(frame.text);
	return { stdout: parts.stdout.join(''), stderr: parts.stderr.join('') };
}
