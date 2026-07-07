import { describe, expect, it } from 'vitest';
import {
	buildMentionRegex,
	extractActiveAgentMentionSlugs,
	extractBacktickedMentionCandidates,
	extractDocCandidates,
	extractMentionCandidates,
	extractTaskCandidates,
	type MentionToken,
	parseMentionMatch,
	stripCode,
	transformMentionsOutsideCode,
} from '../src/mentions/tokens';

const sorted = (a: string[]): string[] => [...a].sort();

describe('parseMentionMatch via buildMentionRegex', () => {
	it('classifies every token kind', () => {
		const input = '@@bob @alice IN-42 TO-7#comment-20261009112345 readme.md assets/diagram.png';
		const tokens: MentionToken[] = [];
		const re = buildMentionRegex();
		let m = re.exec(input);
		while (m !== null) {
			tokens.push(parseMentionMatch(m));
			m = re.exec(input);
		}
		const byKind = Object.fromEntries(tokens.map((t) => [t.kind, t]));
		expect(byKind.passive_agent).toMatchObject({ kind: 'passive_agent', slug: 'bob' });
		expect(byKind.agent).toMatchObject({ kind: 'agent', slug: 'alice' });
		expect(byKind.task).toMatchObject({ kind: 'task', identifier: 'in-42' });
		expect(byKind.comment).toMatchObject({
			kind: 'comment',
			taskIdentifier: 'to-7',
			commentId: '20261009112345',
		});
		expect(byKind.filename).toMatchObject({ kind: 'filename', filename: 'readme.md' });
		expect(byKind.asset).toMatchObject({ kind: 'asset', filename: 'diagram.png' });
	});

	it('matches a filename ending a sentence (trailing period)', () => {
		const kinds = (input: string): MentionToken[] => {
			const out: MentionToken[] = [];
			const re = buildMentionRegex();
			let m = re.exec(input);
			while (m !== null) {
				out.push(parseMentionMatch(m));
				m = re.exec(input);
			}
			return out;
		};
		expect(kinds('Remove architecture-guidelines.md.')).toEqual([
			{
				kind: 'filename',
				raw: 'architecture-guidelines.md',
				filename: 'architecture-guidelines.md',
			},
		]);
		// Two filenames, the second sentence-final.
		expect(kinds('See prd.md, and readme.md.').map((t) => t.raw)).toEqual(['prd.md', 'readme.md']);
		// Sentence-final asset reference.
		expect(kinds('See assets/diagram.png.')).toEqual([
			{ kind: 'asset', raw: 'assets/diagram.png', filename: 'diagram.png' },
		]);
	});

	it('does not match a filename that continues into another path or name segment', () => {
		const raws = (input: string): string[] => {
			const out: string[] = [];
			const re = buildMentionRegex();
			let m = re.exec(input);
			while (m !== null) {
				out.push(m[0]);
				m = re.exec(input);
			}
			return out;
		};
		// A path continuation (`foo.md/bar`) and a further extension segment
		// (`foo.md.bak`) both stay plain text — the trailing dot leads into more.
		expect(raws('path foo.md/bar')).toEqual([]);
		expect(raws('archive foo.md.bak here')).toEqual([]);
	});

	it('returns a fresh regex instance each call', () => {
		const a = buildMentionRegex();
		const b = buildMentionRegex();
		expect(a).not.toBe(b);
		a.exec('@alice');
		expect(b.lastIndex).toBe(0);
	});
});

describe('foldered asset references', () => {
	const tokens = (input: string): MentionToken[] => {
		const out: MentionToken[] = [];
		const re = buildMentionRegex();
		let m = re.exec(input);
		while (m !== null) {
			out.push(parseMentionMatch(m));
			m = re.exec(input);
		}
		return out;
	};

	it('links one- and two-level folder paths', () => {
		expect(tokens('see assets/blog/hero.png')).toEqual([
			{ kind: 'asset', raw: 'assets/blog/hero.png', filename: 'blog/hero.png' },
		]);
		expect(tokens('see assets/blog/images/hero.png')).toEqual([
			{ kind: 'asset', raw: 'assets/blog/images/hero.png', filename: 'blog/images/hero.png' },
		]);
	});

	it('yields no token at all for over-deep paths (fail-clean)', () => {
		// Three folder levels: the whole reference must stay plain text — no
		// partial match of a shorter prefix, no bare-filename match of the tail.
		expect(tokens('see assets/a/b/c/d.png here')).toEqual([]);
	});

	it('handles dotted folder names', () => {
		expect(tokens('assets/blog.v2/readme.md')).toEqual([
			{ kind: 'asset', raw: 'assets/blog.v2/readme.md', filename: 'blog.v2/readme.md' },
		]);
	});

	it('still links when the foldered reference ends a sentence', () => {
		expect(tokens('Ship assets/launch/plan.md.')).toEqual([
			{ kind: 'asset', raw: 'assets/launch/plan.md', filename: 'launch/plan.md' },
		]);
	});

	it('does not link a path continuing past the filename', () => {
		expect(tokens('weird assets/x/y.png/more')).toEqual([]);
	});

	it('keeps the combined-regex capture layout for every token kind', () => {
		// Regression guard: the folder part of ASSET_RE_SRC must be non-capturing
		// or every group index in parseMentionMatch shifts.
		const input = '@@bob @alice IN-42 TO-7#comment-20261009112345 readme.md assets/blog/hero.png';
		const byKind = Object.fromEntries(tokens(input).map((t) => [t.kind, t]));
		expect(byKind.passive_agent).toMatchObject({ slug: 'bob' });
		expect(byKind.agent).toMatchObject({ slug: 'alice' });
		expect(byKind.task).toMatchObject({ identifier: 'in-42' });
		expect(byKind.comment).toMatchObject({
			taskIdentifier: 'to-7',
			commentId: '20261009112345',
		});
		expect(byKind.filename).toMatchObject({ filename: 'readme.md' });
		expect(byKind.asset).toMatchObject({ filename: 'blog/hero.png' });
	});

	it('flows paths through candidate extraction', () => {
		const c = extractMentionCandidates('review assets/launch/2026-07-02-post.md please');
		expect(c.assets).toEqual(['launch/2026-07-02-post.md']);
		const docs = extractDocCandidates('see assets/blog/hero.png', 'Ops');
		expect(docs.assets).toEqual([{ project_slug: 'ops', filename: 'blog/hero.png' }]);
		const ticked = extractBacktickedMentionCandidates('wrapped `assets/blog/hero.png` ref');
		expect(ticked.assets).toEqual(['blog/hero.png']);
	});

	it('rewrites foldered assets via transformMentionsOutsideCode', () => {
		const out = transformMentionsOutsideCode('see assets/blog/hero.png', (t) =>
			t.kind === 'asset' ? `[${t.filename}]` : null,
		);
		expect(out).toBe('see [blog/hero.png]');
	});
});

describe('extractMentionCandidates', () => {
	it('extracts deduped, normalized references and skips code', () => {
		const input = [
			'@alice and @@bob, cc @admin on IN-42 and TO-7#comment-20261009112345',
			'docs: readme.md and asset assets/diagram.png; dup IN-42',
			'```',
			'@charlie ZZ-99 ignored.md',
			'```',
			'inline `@dave EX-1` ignored too',
		].join('\n');
		const c = extractMentionCandidates(input);
		expect(sorted(c.tasks)).toEqual(['in-42', 'to-7']);
		expect(c.filenames).toEqual(['readme.md']);
		expect(c.assets).toEqual(['diagram.png']);
		expect(sorted(c.agents)).toEqual(['alice', 'bob']);
	});
});

describe('extractActiveAgentMentionSlugs', () => {
	it('keeps only active @slug mentions (drops passive, @admin, and code)', () => {
		const input = [
			'@alice pinged @@bob passively and cc @admin',
			'again @Alice (dup, different case)',
			'```',
			'@charlie in a fenced block',
			'```',
			'inline `@dave` too',
		].join('\n');
		expect(sorted(extractActiveAgentMentionSlugs(input))).toEqual(['alice']);
	});

	it('returns [] when there is no active mention', () => {
		expect(extractActiveAgentMentionSlugs('just @@passive and @admin here')).toEqual([]);
		expect(extractActiveAgentMentionSlugs('')).toEqual([]);
	});
});

describe('extractBacktickedMentionCandidates', () => {
	it('finds references inside inline code, ignoring fenced blocks', () => {
		const input = [
			'plain @alice IN-1',
			'inline `@bob TO-2 spec.md` here',
			'```',
			'@charlie IN-3',
			'```',
		].join('\n');
		const c = extractBacktickedMentionCandidates(input);
		expect(c.tasks).toEqual(['to-2']);
		expect(c.agents).toEqual(['bob']);
		expect(c.filenames).toEqual(['spec.md']);
		expect(c.assets).toEqual([]);
	});
});

describe('extractTaskCandidates', () => {
	it('returns deduped lowercased task ids outside code', () => {
		const out = extractTaskCandidates('IN-1 in-1? no, IN-1 and AB-22; `IN-9` skipped');
		expect(sorted(out)).toEqual(['ab-22', 'in-1']);
	});
});

describe('extractDocCandidates', () => {
	it('returns only kb slugs when no project slug is given', () => {
		const c = extractDocCandidates('see readme.md and assets/Plan.png');
		expect(c.kbSlugs).toEqual(['readme.md']);
		expect(c.projectDocs).toEqual([]);
		expect(c.assets).toEqual([]);
	});

	it('scopes project docs and assets to a lowercased project slug', () => {
		const c = extractDocCandidates('see myDoc.md and assets/diagram.png', 'Ops');
		expect(c.kbSlugs).toEqual(['mydoc.md']);
		expect(c.projectDocs).toEqual([{ project_slug: 'ops', filename: 'myDoc.md' }]);
		expect(c.assets).toEqual([{ project_slug: 'ops', filename: 'diagram.png' }]);
	});
});

describe('stripCode', () => {
	it('blanks fenced and inline code', () => {
		expect(stripCode('a `b` c')).toBe('a   c');
		expect(stripCode('x\n```\ncode\n```\ny').includes('code')).toBe(false);
	});
});

describe('transformMentionsOutsideCode', () => {
	it('rewrites tokens outside code and leaves code spans intact', () => {
		const out = transformMentionsOutsideCode('@alice see IN-1 and `@bob IN-2`', (t) =>
			t.kind === 'agent' ? `<${t.slug}>` : null,
		);
		expect(out).toBe('<alice> see IN-1 and `@bob IN-2`');
	});
});
