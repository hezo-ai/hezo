/**
 * Normalize a raw log chunk into clean, display-ready lines.
 *
 * Container/build output is noisy in two ways that make the persisted snapshot
 * unreadable:
 *  - Carriage-return progress redraws (`apt`'s `Reading database ... 5%\r...10%`,
 *    BuildKit spinners) pack many frames onto one physical line. Only the final
 *    frame is meaningful once the line is done, so we collapse to it.
 *  - `\r\n` line endings would otherwise leave a stray `\r` on every line.
 *
 * Splits on `\n`, collapses carriage-return redraws to the last non-empty frame,
 * and drops empty lines. Returns one entry per logical line with no trailing
 * newline (the caller re-terminates).
 */
export function splitLogLines(text: string): string[] {
	const normalized = text.replace(/\r\n/g, '\n');
	const out: string[] = [];
	for (const physicalLine of normalized.split('\n')) {
		const line = lastNonEmptyFrame(physicalLine);
		if (line.length > 0) out.push(line);
	}
	return out;
}

/** Given a line that may contain `\r` redraw frames, return the last non-empty one. */
function lastNonEmptyFrame(line: string): string {
	if (!line.includes('\r')) return line;
	const frames = line.split('\r');
	for (let i = frames.length - 1; i >= 0; i--) {
		if (frames[i].length > 0) return frames[i];
	}
	return '';
}
