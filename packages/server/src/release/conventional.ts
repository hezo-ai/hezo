/**
 * Parsing of Conventional-Commit messages into structured data. Pure functions
 * only — no git/IO — so the release script and its tests share one parser.
 */

export interface ParsedCommit {
	/** Lowercased commit type (e.g. `feat`, `fix`); empty string if the header is non-conventional. */
	type: string;
	/** Scope from `feat(scope):`, or null. */
	scope: string | null;
	/** True when the commit declares a breaking change (`!` in header or `BREAKING CHANGE:` footer). */
	breaking: boolean;
	/** Description text after the `type(scope):` prefix (trailing PR ref stripped). */
	description: string;
	/** Short commit hash. */
	hash: string;
	/** Trailing PR number from a `(#123)` suffix, or null. */
	pr: number | null;
}

export interface RawCommit {
	subject: string;
	body: string;
	hash: string;
}

const HEADER_RE = /^(\w+)(?:\(([^)]+)\))?(!)?: (.+)$/;
const PR_SUFFIX_RE = /\s*\(#(\d+)\)\s*$/;
const BREAKING_FOOTER_RE = /^BREAKING[ -]CHANGE:/m;

export function parseCommit({ subject, body, hash }: RawCommit): ParsedCommit {
	const trimmed = subject.trim();
	const match = HEADER_RE.exec(trimmed);

	let pr: number | null = null;
	const prMatch = PR_SUFFIX_RE.exec(trimmed);
	if (prMatch) {
		pr = Number.parseInt(prMatch[1], 10);
	}

	const breaking = Boolean(match?.[3]) || BREAKING_FOOTER_RE.test(body);

	if (!match) {
		// Strip the trailing PR suffix from the description too, so the renderer's
		// appended "(#N)" isn't duplicated for non-conventional subjects.
		const description = trimmed.replace(PR_SUFFIX_RE, '').trim();
		return { type: '', scope: null, breaking, description, hash, pr };
	}

	const description = match[4].replace(PR_SUFFIX_RE, '').trim();
	return {
		type: match[1].toLowerCase(),
		scope: match[2] ?? null,
		breaking,
		description,
		hash,
		pr,
	};
}
