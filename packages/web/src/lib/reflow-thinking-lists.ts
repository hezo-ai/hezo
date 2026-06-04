/**
 * Reconstructs list structure in agent "thinking" streams.
 *
 * The server flattens thinking text before persisting it: `formatThinking` in
 * `packages/server/src/services/agent-stream-parser.ts` collapses all whitespace
 * (including the newlines the model emitted) into single spaces, so an enumeration
 * the model wrote as a list arrives at the client as one run-on line. This re-inserts
 * newlines before genuine enumeration markers so remark-gfm renders them as
 * `<ol>`/`<ul>` in the formatted log view.
 *
 * High precision by design — when in doubt, leave the text alone:
 *   - Numbered: only a run that is sequential from 1 with >= 2 items is converted.
 *     The marker must be an integer at a non-word boundary followed by `.`/`)` and a
 *     space, so decimals (`3.14`), versions (`v1.2`), hyphenated identifiers (`TO-2`,
 *     `PROJ-123`), `etc.`, and filenames (`research.md`) are never matched.
 *   - Bullets: only unicode glyphs (`•`, `‣`) are recognised. Raw `-`/`*`/`+` are left
 *     untouched because they collide with ranges (`5-10`), emphasis (`*x*`), and `C++`.
 *
 * When nothing qualifies the input is returned unchanged, so plain prose never regresses.
 * Idempotent: re-running, or running on already-newline-delimited markdown, is a no-op
 * (each insertion is skipped when the marker already sits at the start of a line).
 *
 * Inline code spans are not parsed (rare in collapsed thinking); the non-word-boundary
 * guard already neutralises most code-ish numerics.
 */

/** Integer marker at a non-word boundary, e.g. `1.` / `2)`, followed by whitespace. */
const NUMBERED_MARKER = /(?:^|[^\w.)-])(\d{1,3})[.)](?=\s)/g;
/** Unicode list bullets, preceded by start/whitespace and followed by whitespace. */
const BULLET_MARKER = /(?:^|\s)[•‣](?=\s)/g;

interface NumberedMarker {
	/** Index of the first digit (where the newline is spliced in). */
	numStart: number;
	value: number;
}

export function reflowEnumerations(text: string): string {
	return applyBullets(applyNumbered(text));
}

function applyNumbered(text: string): string {
	const markers: NumberedMarker[] = [];
	for (const m of text.matchAll(NUMBERED_MARKER)) {
		if (m.index === undefined) continue;
		// m[0] = optional leading separator + digits + one `.`/`)` delimiter.
		const numStart = m.index + (m[0].length - m[1].length - 1);
		markers.push({ numStart, value: Number(m[1]) });
	}
	const run = firstSequentialRun(markers);
	if (!run) return text;
	return splice(
		text,
		run.map((mk) => mk.numStart),
		(chunk) => chunk,
	);
}

function applyBullets(text: string): string {
	const positions: number[] = [];
	for (const m of text.matchAll(BULLET_MARKER)) {
		if (m.index === undefined) continue;
		// The glyph is the last char of the match (after an optional separator).
		positions.push(m.index + m[0].length - 1);
	}
	if (positions.length < 2) return text;
	// Drop the 1-char glyph and emit a GFM `-` bullet in its place (the space the glyph
	// was followed by becomes the marker's separator). Because the glyph is rewritten, a
	// second pass finds nothing — that is what makes this idempotent.
	return splice(text, positions, (chunk) => chunk, { stripChars: 1, marker: '-' });
}

/**
 * Splice a newline before each marker position so the markers become line-leading
 * (and therefore valid GFM list items). The first marker gets a blank line `\n\n`
 * (terminating the preceding paragraph); subsequent markers get a single `\n` (a tight
 * list). Insertion is skipped when the marker already starts a line, so re-runs no-op.
 */
function splice(
	text: string,
	positions: number[],
	transform: (chunk: string) => string,
	opts?: { stripChars?: number; marker?: string },
): string {
	const stripChars = opts?.stripChars ?? 0;
	const marker = opts?.marker ?? '';
	let out = '';
	let cursor = 0;
	positions.forEach((pos, i) => {
		const chunk = text.slice(cursor, pos);
		if (/(?:^|\n)[ \t]*$/.test(chunk)) {
			// Already at the start of a line — leave it untouched (idempotency).
			out += transform(chunk) + marker;
		} else {
			const trimmed = chunk.replace(/[ \t]+$/, '');
			out += transform(trimmed) + (i === 0 ? '\n\n' : '\n') + marker;
		}
		cursor = pos + stripChars;
	});
	out += text.slice(cursor);
	return out;
}

/** First run of markers whose values are exactly 1, 2, 3, … (length >= 2), else null. */
function firstSequentialRun(markers: NumberedMarker[]): NumberedMarker[] | null {
	let run: NumberedMarker[] = [];
	let expected = 1;
	for (const mk of markers) {
		if (mk.value === expected) {
			run.push(mk);
			expected++;
		} else if (mk.value === 1) {
			if (run.length >= 2) return run;
			run = [mk];
			expected = 2;
		} else {
			if (run.length >= 2) return run;
			run = [];
			expected = 1;
		}
	}
	return run.length >= 2 ? run : null;
}
