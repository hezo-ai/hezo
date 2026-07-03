/**
 * Hides a legacy "metadata header" block from a project doc's *rendered* view.
 *
 * Older docs (and agents that haven't adopted the revision changelog yet) open
 * with a run-on block of `Label: value` / `**Label:** value` lines — Status,
 * Date, Author, Purpose, … — which CommonMark collapses into one ugly paragraph.
 * The structured metadata banner replaces it, so this removes that leading block
 * from what we render (display only — the stored markdown is untouched, and the
 * raw block is still there in Edit mode).
 *
 * High precision by design — when in doubt, return the content UNCHANGED so a
 * normal document never regresses. A block only qualifies when BOTH hold:
 *   1. it yields >= 2 `Label:` fields, and
 *   2. the first field's label is a known leading key (status/date/created/
 *      updated/author/owner) — the near-universal opener of these headers.
 * Labels containing markdown-link punctuation (`[` `]` `(` `)`) are rejected, so
 * a bold span inside a value can't masquerade as a field label.
 *
 * An optional leading ATX heading (`# Title`) is preserved — only the metadata
 * block directly after it is stripped.
 */

const LEADING_KEYS = new Set(['status', 'date', 'created', 'updated', 'author', 'owner']);

/** A leading ATX heading line plus the blank line(s) after it. */
const LEADING_HEADING = /^[ \t]*#{1,6}[ \t]+[^\n]*\n+/;
/** The first blank-line-delimited block (a run of non-blank lines) at the start. */
const FIRST_BLOCK = /^[ \t]*\S[^\n]*(?:\n(?![ \t]*\n)[^\n]*)*/;
/** A bold field label: `**Label:**`, with no link punctuation inside. */
const BOLD_LABEL = /\*\*([^*\n[\]()]{1,40}?):\*\*/g;
/** A per-line field label: `Label: value` at the start of a line. */
const LINE_LABEL = /^[ \t]*([A-Za-z][\w /-]{0,29}):[ \t]+\S/;

function normalizeLabel(label: string): string {
	return label.trim().toLowerCase();
}

/** True when `block` opens with a recognisable metadata header (see file docstring). */
function looksLikeMetadata(block: string): boolean {
	const bold = [...block.matchAll(BOLD_LABEL)].map((m) => normalizeLabel(m[1]));
	if (bold.length >= 2 && LEADING_KEYS.has(bold[0])) return true;

	const perLine: string[] = [];
	for (const line of block.split('\n')) {
		const m = line.match(LINE_LABEL);
		if (m) perLine.push(normalizeLabel(m[1]));
	}
	return perLine.length >= 2 && LEADING_KEYS.has(perLine[0]);
}

/**
 * Returns `content` with a leading metadata block removed for display, or the
 * original content unchanged when no confident metadata block is found.
 */
export function stripLeadingMetadataBlock(content: string): string {
	const normalized = content.replace(/\r\n/g, '\n');
	const heading = normalized.match(LEADING_HEADING);
	const headingLen = heading ? heading[0].length : 0;
	const rest = normalized.slice(headingLen);

	const blockMatch = rest.match(FIRST_BLOCK);
	if (!blockMatch) return content;
	const block = blockMatch[0];
	if (!looksLikeMetadata(block)) return content;

	const after = rest.slice(block.length).replace(/^\n+/, '');
	return normalized.slice(0, headingLen) + after;
}
