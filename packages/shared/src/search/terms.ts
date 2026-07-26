/**
 * Free-text → match terms. The normalization half of team discovery: it turns a
 * project brief (or a team's own text) into a comparable bag of stemmed terms.
 *
 * This module is deliberately **domain-neutral** — generic English machinery, no
 * knowledge of any particular team. *Which* words mean "this team" is authored
 * data (`keywords` on a marketplace team manifest), not code, so a team published
 * to the marketplace can carry its own vocabulary without a code change. It lives
 * in `@hezo/shared` because both sides of the match need the same normalizer: the
 * web ranker on the query side, and the server on the authoring side when it
 * generates and validates a published team's keywords.
 */

/**
 * Function words that carry no signal about *which* team fits. Every project
 * brief and every team summary is full of them, so scoring them ranks teams by
 * how much prose they happen to ship. Only words longer than 2 characters need
 * listing — shorter tokens are dropped outright. Domain vocabulary ("app",
 * "team", "content", "market", "research", …) is deliberately absent.
 *
 * The list is matched against the raw word *and* its stem, so a few entries are
 * stems rather than words ("thi" ← "this", "doe" ← "does", "don" ← "don't").
 */
const STOPWORDS = new Set([
	'about',
	'after',
	'again',
	'all',
	'also',
	'and',
	'any',
	'are',
	'because',
	'been',
	'before',
	'being',
	'both',
	'but',
	'can',
	'could',
	'did',
	'doe',
	'don',
	'each',
	'either',
	'etc',
	'even',
	'ever',
	'every',
	'for',
	'from',
	'get',
	'had',
	'has',
	'have',
	'her',
	'here',
	'him',
	'his',
	'how',
	'into',
	'its',
	'itself',
	'just',
	'like',
	'may',
	'might',
	'more',
	'most',
	'much',
	'must',
	'need',
	'not',
	'now',
	'off',
	'once',
	'one',
	'only',
	'onto',
	'other',
	'our',
	'out',
	'over',
	'own',
	'per',
	'rather',
	'really',
	'same',
	'she',
	'should',
	'since',
	'some',
	'such',
	'than',
	'that',
	'the',
	'their',
	'them',
	'then',
	'there',
	'these',
	'they',
	'thi',
	'this',
	'those',
	'through',
	'too',
	'two',
	'under',
	'until',
	'upon',
	'use',
	'very',
	'via',
	'want',
	'was',
	'way',
	'were',
	'what',
	'when',
	'where',
	'which',
	'while',
	'who',
	'whose',
	'why',
	'will',
	'with',
	'would',
	'you',
	'your',
]);

/** Shortest token worth scoring; below this a word is almost always noise. */
export const MIN_TERM_LENGTH = 3;

/**
 * Collapse a word to a crude stem so obvious morphological variants match:
 * plurals first ("apps" → "app", "publishes" → "publish", "verifies" → "verify"),
 * then verb/agent endings, applied repeatedly so "engineering" → "engineer" →
 * "engin" lands on the same stem as "engineer".
 *
 * Length guards keep short words intact, which is what makes matching precise:
 * "app" is never rewritten, and nothing rewrites "approval" down to it. Callers
 * must stem BOTH sides of a comparison — the stems are an internal representation
 * with no meaning outside this function.
 */
export function stemTerm(word: string): string {
	let w = word;
	if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
	else if (w.length > 4 && /(?:s|x|z|ch|sh)es$/.test(w)) w = w.slice(0, -2);
	// "business" / "status" are not plurals.
	else if (w.length > 3 && w.endsWith('s') && !/(?:ss|us)$/.test(w)) w = w.slice(0, -1);

	// Two passes at most: "engineering" → "engineer" → "engin".
	for (let pass = 0; pass < 2; pass++) {
		if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
		else if (w.length > 5 && (w.endsWith('ed') || w.endsWith('er'))) w = w.slice(0, -2);
		else break;
	}
	return w;
}

/**
 * Split free text into scoreable terms: alphanumeric words of at least
 * `MIN_TERM_LENGTH` characters, stemmed, with function words dropped (checked
 * both before and after stemming, so "uses" is discarded along with "use").
 *
 * Multi-word input is handled naturally — a keyword phrase like "todo list"
 * contributes both of its terms.
 */
export function extractTerms(text: string): string[] {
	const terms: string[] = [];
	for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
		if (word.length < MIN_TERM_LENGTH || STOPWORDS.has(word)) continue;
		const stem = stemTerm(word);
		if (STOPWORDS.has(stem)) continue;
		terms.push(stem);
	}
	return terms;
}

/** The distinct terms in `text`, order-preserving. */
export function uniqueTerms(text: string): string[] {
	return Array.from(new Set(extractTerms(text)));
}

/**
 * Ceilings on an authored keyword list. Hezo's own teams sit well inside these;
 * they exist because the marketplace will accept teams from outside this repo,
 * where an unbounded list is a ranking-spam vector (and a paragraph pasted into
 * one entry is an authoring mistake worth failing loudly on).
 */
export const MAX_TEAM_KEYWORDS = 80;
export const MAX_TEAM_KEYWORD_LENGTH = 60;

/**
 * Reject a keyword list that breaches the ceilings, returning a human-readable
 * reason or null when it is fine. Callers decide the consequence: the marketplace
 * build throws (an authoring error should fail the build), while the eventual
 * publish path can surface it to the publisher.
 */
export function teamKeywordsError(keywords: readonly string[]): string | null {
	if (keywords.length > MAX_TEAM_KEYWORDS) {
		return `too many keywords (${keywords.length} > ${MAX_TEAM_KEYWORDS})`;
	}
	const tooLong = keywords.find((k) => k.length > MAX_TEAM_KEYWORD_LENGTH);
	if (tooLong !== undefined) {
		return `keyword longer than ${MAX_TEAM_KEYWORD_LENGTH} characters: "${tooLong.slice(0, 40)}…"`;
	}
	return null;
}

/**
 * Normalize an authored keyword list for storage in a team manifest: trim, drop
 * blanks, lowercase, and de-duplicate while preserving authoring order. Keywords
 * are stored as **readable words and short phrases**, not stems — the stemmer is
 * a matcher implementation detail, so baking its output into a published
 * marketplace file would freeze one matcher version into the data forever, and
 * would make the list unreviewable in a diff.
 */
export function normalizeKeywords(keywords: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of keywords) {
		const value = raw.trim().toLowerCase().replace(/\s+/g, ' ');
		if (!value || seen.has(value)) continue;
		seen.add(value);
		out.push(value);
	}
	return out;
}
