import { ADMIN_MENTION_SLUG } from '../constants.js';

/**
 * Canonical mention/reference syntax shared by every surface that parses or
 * renders entity references (the web remark plugin, the server-side channel
 * renderer, candidate extraction for resolve endpoints). The syntax itself is
 * documented for agents in agents/_partials/common/linking-syntax.md — bare
 * identifiers, never wrapped in backticks.
 */

export const PASSIVE_AGENT_RE_SRC = String.raw`(?<![\w@])@@([a-z][\w-]*)(?![\w/])`;
export const AGENT_RE_SRC = String.raw`(?<![\w@])@([a-z][\w-]*)(?![\w/])`;
export const TASK_RE_SRC = String.raw`(?<![\w-])([A-Z][A-Z0-9]{1,3}-\d+)(?![\w-])`;
// Comment links embed a task identifier plus the comment's `public_id`
// (`IN-42#comment-20261009112345`), reusing the `#comment-<public_id>` URL hash.
// A comment's public_id is its creation timestamp (`YYYYMMDDHHMMSS`, UTC) with
// an optional `-N` suffix when several comments on a task share a second. The id
// is shape-matched so `IN-42#comment-foo` prose stays plain text. This MUST come
// before TASK_RE_SRC in the alternation: regex alternation prefers the leftmost
// matching branch at a position, so otherwise TASK_RE_SRC consumes the bare
// `IN-42` prefix and the `#comment-...` suffix is left dangling.
export const COMMENT_LINK_RE_SRC = String.raw`(?<![\w-])([A-Z][A-Z0-9]{1,3}-\d+)#comment-(\d{14}(?:-\d+)?)(?![\w-])`;
export const FILENAME_RE_SRC = String.raw`(?<![\w/.-])([a-z0-9][\w-]*\.[a-z0-9]+)(?![\w/.-])`;
// Asset references are path-prefixed (`assets/<name>.<ext>`) and may contain
// uppercase (e.g. a task identifier embedded in the name). The leading `assets/`
// keeps them from colliding with the bare project-doc filenames above.
export const ASSET_RE_SRC = String.raw`(?<![\w/.-])assets/([A-Za-z0-9][\w.-]*\.[A-Za-z0-9]+)(?![\w/.-])`;

/**
 * Combined mention regex. Capture-group layout (consumed by
 * `parseMentionMatch`): 1 = passive agent slug, 2 = agent slug, 3+4 = comment
 * link (task identifier, comment public_id), 5 = task identifier, 6 = bare
 * filename, 7 = asset filename.
 *
 * Returns a fresh `g`-flagged instance per call — `g` regexes carry
 * `lastIndex` state, so a shared module-level instance would corrupt
 * concurrent or re-entrant scans.
 */
export function buildMentionRegex(): RegExp {
	return new RegExp(
		`${PASSIVE_AGENT_RE_SRC}|${AGENT_RE_SRC}|${COMMENT_LINK_RE_SRC}|${TASK_RE_SRC}|${FILENAME_RE_SRC}|${ASSET_RE_SRC}`,
		'g',
	);
}

export type MentionToken = { raw: string } & (
	| { kind: 'passive_agent'; slug: string }
	| { kind: 'agent'; slug: string }
	| { kind: 'comment'; taskIdentifier: string; commentId: string }
	| { kind: 'task'; identifier: string }
	| { kind: 'filename'; filename: string }
	| { kind: 'asset'; filename: string }
);

/**
 * Maps a `buildMentionRegex()` match to a typed token. Slugs and task
 * identifiers are lowercased (resolution is case-insensitive); filenames keep
 * their exact case (project docs and assets match exact-case); `raw` always
 * preserves the matched text for display.
 */
export function parseMentionMatch(m: RegExpExecArray): MentionToken {
	const raw = m[0];
	if (m[1]) return { kind: 'passive_agent', raw, slug: m[1].toLowerCase() };
	if (m[2]) return { kind: 'agent', raw, slug: m[2].toLowerCase() };
	if (m[3] && m[4]) {
		return { kind: 'comment', raw, taskIdentifier: m[3].toLowerCase(), commentId: m[4] };
	}
	if (m[5]) return { kind: 'task', raw, identifier: m[5].toLowerCase() };
	if (m[6]) return { kind: 'filename', raw, filename: m[6] };
	return { kind: 'asset', raw, filename: m[7] };
}

export interface MentionCandidates {
	/** Lowercased task identifiers (includes the task part of comment links). */
	tasks: string[];
	/** Exact-case bare filenames (project docs / KB slugs). */
	filenames: string[];
	/** Exact-case asset filenames (without the `assets/` prefix). */
	assets: string[];
	/** Lowercased agent slugs from @/@@ mentions; `@admin` is excluded. */
	agents: string[];
}

/**
 * Extracts every resolvable reference from `value` (code blocks and inline
 * code stripped first), deduped. Used to build resolve-endpoint requests.
 */
export function extractMentionCandidates(value: string): MentionCandidates {
	const stripped = stripCode(value);
	const tasks = new Set<string>();
	const filenames = new Set<string>();
	const assets = new Set<string>();
	const agents = new Set<string>();
	const re = buildMentionRegex();
	let m = re.exec(stripped);
	while (m !== null) {
		const token = parseMentionMatch(m);
		switch (token.kind) {
			case 'task':
				tasks.add(token.identifier);
				break;
			case 'comment':
				tasks.add(token.taskIdentifier);
				break;
			case 'filename':
				filenames.add(token.filename);
				break;
			case 'asset':
				assets.add(token.filename);
				break;
			case 'agent':
			case 'passive_agent':
				if (token.slug !== ADMIN_MENTION_SLUG) agents.add(token.slug);
				break;
		}
		m = re.exec(stripped);
	}
	return {
		tasks: Array.from(tasks),
		filenames: Array.from(filenames),
		assets: Array.from(assets),
		agents: Array.from(agents),
	};
}

export function extractTaskCandidates(value: string): string[] {
	const stripped = stripCode(value);
	const re = new RegExp(TASK_RE_SRC, 'g');
	const out = new Set<string>();
	let m = re.exec(stripped);
	while (m !== null) {
		out.add(m[1].toLowerCase());
		m = re.exec(stripped);
	}
	return Array.from(out);
}

export interface DocCandidates {
	kbSlugs: string[];
	projectDocs: Array<{ project_slug: string; filename: string }>;
	assets: Array<{ project_slug: string; filename: string }>;
}

export function extractDocCandidates(value: string, projectSlug?: string): DocCandidates {
	const stripped = stripCode(value);
	const filenameSet = new Set<string>();

	const re = new RegExp(FILENAME_RE_SRC, 'g');
	let m = re.exec(stripped);
	while (m !== null) {
		filenameSet.add(m[1]);
		m = re.exec(stripped);
	}

	const assetSet = new Set<string>();
	const assetRe = new RegExp(ASSET_RE_SRC, 'g');
	let am = assetRe.exec(stripped);
	while (am !== null) {
		assetSet.add(am[1]);
		am = assetRe.exec(stripped);
	}

	const kbSlugs = Array.from(filenameSet, (f) => f.toLowerCase());
	const projectDocs: Array<{ project_slug: string; filename: string }> = [];
	const assets: Array<{ project_slug: string; filename: string }> = [];
	if (projectSlug) {
		const slug = projectSlug.toLowerCase();
		for (const filename of filenameSet) {
			projectDocs.push({ project_slug: slug, filename });
		}
		for (const filename of assetSet) {
			assets.push({ project_slug: slug, filename });
		}
	}

	return { kbSlugs, projectDocs, assets };
}

export function stripCode(value: string): string {
	return value.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, ' ').replace(/`[^`]*`/g, ' ');
}

// Same shapes stripCode blanks out, but as a splitter so code segments can be
// preserved verbatim rather than erased.
const CODE_SEGMENT_RE_SRC = '```[\\s\\S]*?```|~~~[\\s\\S]*?~~~|`[^`]*`';

/**
 * Rewrites mention tokens in `value` via `replace`, leaving code fences and
 * inline code untouched — the string-level equivalent of the remark plugin
 * skipping `code`/`inlineCode` mdast nodes. `replace` returns the replacement
 * text for a token, or null to keep the original text.
 */
export function transformMentionsOutsideCode(
	value: string,
	replace: (token: MentionToken) => string | null,
): string {
	const codeRe = new RegExp(CODE_SEGMENT_RE_SRC, 'g');
	let out = '';
	let last = 0;
	let m = codeRe.exec(value);
	while (m !== null) {
		out += transformSegment(value.slice(last, m.index), replace);
		out += m[0];
		last = m.index + m[0].length;
		m = codeRe.exec(value);
	}
	out += transformSegment(value.slice(last), replace);
	return out;
}

function transformSegment(
	segment: string,
	replace: (token: MentionToken) => string | null,
): string {
	if (segment === '') return segment;
	const re = buildMentionRegex();
	let out = '';
	let last = 0;
	let m = re.exec(segment);
	while (m !== null) {
		const replacement = replace(parseMentionMatch(m));
		if (replacement !== null) {
			out += segment.slice(last, m.index) + replacement;
			last = m.index + m[0].length;
		}
		m = re.exec(segment);
	}
	return out + segment.slice(last);
}
