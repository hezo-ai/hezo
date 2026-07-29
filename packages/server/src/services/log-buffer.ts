/**
 * Append-only line buffer with a hard byte cap. Each appended line is stored on
 * its own line (newline-terminated). Lines tagged as `stderr` are stored with a
 * `[stderr] ` prefix so the persisted log preserves stream provenance when later
 * replayed as plain text — the prefix sits at the start of its own line so the
 * reader can strip it back off cleanly.
 *
 * INVARIANT: the buffer is prefix-stable — every earlier `toString()` result is
 * a strict prefix of every later one. Parts are append-only, and the truncation
 * marker is appended exactly once at the cap, after which `append()` is a no-op.
 * The log broker's delta flushing (log-stream-broker.ts) slices new text off by
 * a persisted character offset and silently corrupts persisted logs if this ever
 * breaks.
 *
 * Reads are offset-addressable (`length` + `sliceFrom`) precisely so the flusher
 * never has to materialize the whole log to find its delta. It used to call
 * `toString()` on every 500ms flush and slice the tail off the result, which
 * joined an array growing toward the 10 MB cap twice a second, per run — O(n^2)
 * allocation over a run and, at ten concurrent runs, the largest source of GC
 * pressure in the process. `toString()` remains for whole-log readers and is
 * memoized, so repeated reads of an idle buffer are free.
 */
export class CappedLogBuffer {
	private bytes = 0;
	private parts: string[] = [];
	/** `offsets[i]` is the character index at which `parts[i]` starts. */
	private offsets: number[] = [];
	/** Total characters across `parts`, excluding the truncation marker. */
	private chars = 0;
	private truncatedAt: number | null = null;
	private joined: string | null = null;

	constructor(private readonly capBytes: number) {}

	append(stream: 'stdout' | 'stderr', text: string): void {
		if (this.truncatedAt !== null) return;
		const marker = `${stream === 'stderr' ? `[stderr] ${text}` : text}\n`;
		const remaining = this.capBytes - this.bytes;
		if (remaining <= 0) {
			this.truncatedAt = this.capBytes;
			this.joined = null;
			return;
		}
		if (marker.length > remaining) {
			this.push(marker.slice(0, remaining));
			this.bytes = this.capBytes;
			this.truncatedAt = this.capBytes;
		} else {
			this.push(marker);
			this.bytes += marker.length;
		}
		this.joined = null;
	}

	/** Total length of `toString()`, without building it. */
	get length(): number {
		return this.chars + this.truncationSuffix().length;
	}

	/**
	 * The text from character `offset` onward — the same result as
	 * `toString().slice(offset)`, but touching only the parts that actually
	 * carry it. An offset at or past the end returns `''`.
	 */
	sliceFrom(offset: number): string {
		const suffix = this.truncationSuffix();
		if (offset <= 0) return this.toString();
		if (offset >= this.length) return '';
		if (offset >= this.chars) return suffix.slice(offset - this.chars);

		const first = this.partIndexAt(offset);
		const head = this.parts[first].slice(offset - this.offsets[first]);
		if (first === this.parts.length - 1) return head + suffix;
		return head + this.parts.slice(first + 1).join('') + suffix;
	}

	toString(): string {
		if (this.joined === null) this.joined = this.parts.join('');
		return this.joined + this.truncationSuffix();
	}

	get isTruncated(): boolean {
		return this.truncatedAt !== null;
	}

	private push(part: string): void {
		this.offsets.push(this.chars);
		this.parts.push(part);
		this.chars += part.length;
	}

	private truncationSuffix(): string {
		return this.truncatedAt === null
			? ''
			: `\n...[truncated — log capped at ${this.truncatedAt} bytes]`;
	}

	/** Index of the part containing `offset`; `offsets` is sorted by construction. */
	private partIndexAt(offset: number): number {
		let lo = 0;
		let hi = this.parts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (this.offsets[mid] <= offset) lo = mid;
			else hi = mid - 1;
		}
		return lo;
	}
}
