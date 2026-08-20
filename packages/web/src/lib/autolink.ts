/**
 * Autolinking for the text surfaces whose bytes carry no markup - a CSV cell, a
 * plain-text asset body. Markdown reaches the same reading through remark-gfm's
 * autolink literals; this is the equivalent for files that have no syntax, so a
 * URL sitting in a column is a link rather than a string to copy out by hand.
 *
 * The rules follow GFM's autolink literals closely enough that the two surfaces
 * agree on what counts as a link: `http(s)://`, a bare `www.` host, an explicit
 * `mailto:`, and a bare email address. Trailing sentence punctuation and an
 * unbalanced closing bracket stay outside the link.
 *
 * Only those four forms ever produce an href, so no other scheme (`javascript:`,
 * `data:`) can be emitted from file content the instance did not author.
 */

export interface LinkRange {
	/** Offset of the link's first character in the string it was found in. */
	start: number;
	/** Offset one past its last character. */
	end: number;
	/** Absolute URL for the anchor's `href` (a `www.` host gains `https://`). */
	href: string;
}

// A scheme-led or `www.`-led run of non-space characters, or a bare email
// address. Quotes, angle brackets and backticks end a run: in a delimited file
// they are far more likely to be the text around a URL than part of one.
const CANDIDATE_RE =
	/(?:https?:\/\/|mailto:|www\.)[^\s<>"'`\\]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/gi;

// What a link may follow. Anything else means the match continues a word
// (`xhttps://…`, a path segment) and is not a link of its own.
const BOUNDARY_BEFORE_RE = /[\s(\[{<"'`,;:*_~|]/;

/** Sentence punctuation a link never ends on, trimmed back off the match. */
const TRAILING_PUNCTUATION = new Set(['?', '!', '.', ',', ':', ';', '*', '_', '~', "'", '"']);

/** Closing brackets, trimmed only when the match holds no opener for them. */
const CLOSERS = new Map([
	[')', '('],
	[']', '['],
	['}', '{'],
]);

const HOST_RE = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*$/;
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

/** Occurrences of `ch` in `text[0, end)`. */
function countBefore(text: string, ch: string, end: number): number {
	let count = 0;
	for (let i = 0; i < end; i++) if (text[i] === ch) count++;
	return count;
}

/** Drop trailing punctuation and unbalanced closers ("(see https://x.com/a)."). */
function trimTrailing(text: string): string {
	let end = text.length;
	while (end > 0) {
		const ch = text[end - 1];
		if (TRAILING_PUNCTUATION.has(ch)) {
			end--;
			continue;
		}
		const opener = CLOSERS.get(ch);
		if (opener !== undefined && countBefore(text, opener, end) < countBefore(text, ch, end)) {
			end--;
			continue;
		}
		break;
	}
	return text.slice(0, end);
}

/** The authority of an absolute URL: everything between `://` and `/?#`. */
function hostOf(url: string): string {
	const afterScheme = url.slice(url.indexOf('://') + 3);
	const end = afterScheme.search(/[/?#]/);
	const authority = end === -1 ? afterScheme : afterScheme.slice(0, end);
	// Userinfo and port are not part of the name being validated.
	const host = authority.slice(authority.lastIndexOf('@') + 1);
	return host.replace(/:\d*$/, '');
}

/** A named host with a dot in it, or `localhost`. Bare IPv6 is not linked. */
function isValidHost(host: string): boolean {
	if (!HOST_RE.test(host)) return false;
	return host.includes('.') || host.toLowerCase() === 'localhost';
}

/** The href a candidate resolves to, or null when it is not a link after all. */
function hrefFor(candidate: string): string | null {
	const lower = candidate.toLowerCase();
	if (lower.startsWith('mailto:')) {
		return EMAIL_RE.test(candidate.slice('mailto:'.length)) ? candidate : null;
	}
	if (lower.startsWith('http://') || lower.startsWith('https://')) {
		return isValidHost(hostOf(candidate)) ? candidate : null;
	}
	if (lower.startsWith('www.')) {
		const url = `https://${candidate}`;
		const host = hostOf(url);
		// A `www.` host needs a real domain under it - `www.example.com`, not `www.x`.
		return isValidHost(host) && host.split('.').length >= 3 ? url : null;
	}
	return EMAIL_RE.test(candidate) ? `mailto:${candidate}` : null;
}

/**
 * Every link in `text`, in ascending order and never overlapping - the shape
 * `segmentsForSlice` splits a text stream on.
 */
export function findLinkRanges(text: string): LinkRange[] {
	const ranges: LinkRange[] = [];
	CANDIDATE_RE.lastIndex = 0;
	for (let match = CANDIDATE_RE.exec(text); match; match = CANDIDATE_RE.exec(text)) {
		const start = match.index;
		const before = start === 0 ? undefined : text[start - 1];
		if (before !== undefined && !BOUNDARY_BEFORE_RE.test(before)) continue;
		const candidate = trimTrailing(match[0]);
		if (candidate === '') continue;
		const href = hrefFor(candidate);
		if (href === null) continue;
		ranges.push({ start, end: start + candidate.length, href });
	}
	return ranges;
}

/** The same ranges, shifted into a wider stream that `text` starts at `offset` in. */
export function shiftLinkRanges(ranges: LinkRange[], offset: number): LinkRange[] {
	if (offset === 0) return ranges;
	return ranges.map((r) => ({ start: r.start + offset, end: r.end + offset, href: r.href }));
}
