import { HIGHLIGHT_SENTINEL, markdownToPreviewText } from '@hezo/shared';

/**
 * Builds the gray preview line for a search result. Full-text search matches by
 * keyword + stemming, so the typed term (or its stem) is usually present in the
 * text — we centre a window on the first occurrence and wrap each one in
 * {@link HIGHLIGHT_SENTINEL} so the web palette can render `<mark>`. When the
 * stemmer can't line the term up with the stored text we fall back to the lead
 * text with no markers.
 *
 * Pure (no DB) so it runs identically under Node (vitest) and Bun (prod), and is
 * unit-testable in isolation. Generalises `buildSnippet` in `routes/inbox.ts`,
 * which shares this module's markdown strip.
 */

const SNIPPET_MAX_LEN = 200;
/** Context chars kept before the first match so it isn't flush-left. */
const WINDOW_PAD = 60;
/** Only terms this long get a morphological (stem) fallback. */
const MIN_STEM_TERM_LEN = 4;
/** Cap wrapped occurrences so a common short term doesn't make a sea of marks. */
const MAX_HIGHLIGHTS = 8;

export interface HighlightedSnippet {
	snippet: string;
	/** True when the query matched literally in `raw` (drives `<mark>` + the label). */
	matched: boolean;
}

/**
 * Collapse whitespace and strip the markdown syntax that would otherwise land
 * inside a highlight (`##`, `**`, list/quote markers, link/image wrappers, code
 * backticks). Runs before any windowing so offsets stay stable. Shares the strip
 * with every other preview line via `markdownToPreviewText`, so a search result
 * and an inbox row read the same body the same way.
 */
function normalize(raw: string | null | undefined): string {
	if (!raw) return '';
	// Defensive; NUL can't occur in the corpus.
	return markdownToPreviewText(raw.split(HIGHLIGHT_SENTINEL).join(''));
}

/** Lowercased query tokens; drop sub-2-char tokens unless that empties the set. */
function queryTerms(query: string): string[] {
	const all = query
		.toLowerCase()
		.split(/\s+/)
		.map((t) => t.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ''))
		.filter((t) => t.length > 0);
	const longer = all.filter((t) => t.length >= 2);
	return longer.length > 0 ? longer : all;
}

/** Crude English suffix stripper so "marking"/"marked" share the stem "mark". */
function stem(term: string): string {
	for (const suffix of ['ing', 'edly', 'ed', 'es', 'ly', 's']) {
		if (term.endsWith(suffix) && term.length - suffix.length >= 3) {
			return term.slice(0, -suffix.length);
		}
	}
	return term;
}

function isWordChar(ch: string | undefined): boolean {
	return ch !== undefined && /[a-z0-9]/.test(ch);
}

/** The needle to search for a term, or null when it occurs nowhere in `lower`. */
function needleFor(term: string, lower: string): string | null {
	if (lower.includes(term)) return term;
	if (term.length >= MIN_STEM_TERM_LEN) {
		const s = stem(term);
		if (s !== term && s.length >= 3 && lower.includes(s)) return s;
	}
	return null;
}

function mergeOverlapping(ranges: Array<[number, number]>): Array<[number, number]> {
	const merged: Array<[number, number]> = [];
	for (const [s, e] of ranges) {
		const last = merged[merged.length - 1];
		if (last && s <= last[1]) last[1] = Math.max(last[1], e);
		else merged.push([s, e]);
	}
	return merged;
}

/** Sorted, merged match ranges for all terms; short (≤2 char) needles must be word-bounded. */
function findRanges(text: string, terms: string[]): Array<[number, number]> {
	const lower = text.toLowerCase();
	const ranges: Array<[number, number]> = [];
	for (const term of terms) {
		const needle = needleFor(term, lower);
		if (!needle) continue;
		const wordBoundary = needle.length <= 2;
		let from = 0;
		for (;;) {
			const idx = lower.indexOf(needle, from);
			if (idx === -1) break;
			const end = idx + needle.length;
			if (!wordBoundary || (!isWordChar(lower[idx - 1]) && !isWordChar(lower[end]))) {
				ranges.push([idx, end]);
			}
			from = end;
		}
	}
	ranges.sort((a, b) => a[0] - b[0]);
	return mergeOverlapping(ranges);
}

function truncateLead(text: string): string {
	if (text.length <= SNIPPET_MAX_LEN) return text;
	return `${text.slice(0, SNIPPET_MAX_LEN).trimEnd()}…`;
}

/** Slice `[start,end)` of `text`, wrapping in-window ranges with the sentinel. */
function wrapWindow(
	text: string,
	start: number,
	end: number,
	ranges: Array<[number, number]>,
): string {
	let out = '';
	let cursor = start;
	let count = 0;
	for (const [rs, re] of ranges) {
		if (re <= start || rs >= end) continue;
		if (count >= MAX_HIGHLIGHTS) break;
		const s = Math.max(rs, start);
		const e = Math.min(re, end);
		if (s > cursor) out += text.slice(cursor, s);
		out += `${HIGHLIGHT_SENTINEL}${text.slice(s, e)}${HIGHLIGHT_SENTINEL}`;
		cursor = e;
		count++;
	}
	if (cursor < end) out += text.slice(cursor, end);
	return out;
}

export function buildHighlightedSnippet(
	raw: string | null | undefined,
	query: string,
): HighlightedSnippet {
	const text = normalize(raw);
	if (!text) return { snippet: '', matched: false };

	const ranges = findRanges(text, queryTerms(query));
	if (ranges.length === 0) {
		return { snippet: truncateLead(text), matched: false };
	}

	const firstStart = ranges[0][0];
	let start = Math.max(0, firstStart - WINDOW_PAD);
	const end = Math.min(text.length, start + SNIPPET_MAX_LEN);
	start = Math.max(0, end - SNIPPET_MAX_LEN); // backfill the window if we hit the end

	const windowed = wrapWindow(text, start, end, ranges);
	const prefix = start > 0 ? '…' : '';
	const suffix = end < text.length ? '…' : '';
	return { snippet: `${prefix}${windowed}${suffix}`, matched: true };
}
