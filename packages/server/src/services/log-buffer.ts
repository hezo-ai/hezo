/**
 * Append-only line buffer with a hard byte cap. Each appended line is stored on
 * its own line (newline-terminated). Lines tagged as `stderr` are stored with a
 * `[stderr] ` prefix so the persisted log preserves stream provenance when later
 * replayed as plain text — the prefix sits at the start of its own line so the
 * reader can strip it back off cleanly.
 */
export class CappedLogBuffer {
	private bytes = 0;
	private parts: string[] = [];
	private truncatedAt: number | null = null;

	constructor(private readonly capBytes: number) {}

	append(stream: 'stdout' | 'stderr', text: string): void {
		if (this.truncatedAt !== null) return;
		const marker = `${stream === 'stderr' ? `[stderr] ${text}` : text}\n`;
		const remaining = this.capBytes - this.bytes;
		if (remaining <= 0) {
			this.truncatedAt = this.capBytes;
			return;
		}
		if (marker.length > remaining) {
			this.parts.push(marker.slice(0, remaining));
			this.bytes = this.capBytes;
			this.truncatedAt = this.capBytes;
		} else {
			this.parts.push(marker);
			this.bytes += marker.length;
		}
	}

	toString(): string {
		const text = this.parts.join('');
		if (this.truncatedAt !== null) {
			return `${text}\n...[truncated — log capped at ${this.truncatedAt} bytes]`;
		}
		return text;
	}

	get isTruncated(): boolean {
		return this.truncatedAt !== null;
	}
}
