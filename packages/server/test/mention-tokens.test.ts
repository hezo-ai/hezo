import {
	agentPath,
	assetPath,
	buildMentionRegex,
	commentPath,
	extractMentionCandidates,
	type MentionToken,
	parseMentionMatch,
	projectDocPath,
	projectInboxPath,
	taskPath,
	transformMentionsOutsideCode,
} from '@hezo/shared';
import { describe, expect, it } from 'vitest';

const UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

function tokensOf(value: string): MentionToken[] {
	const re = buildMentionRegex();
	const out: MentionToken[] = [];
	let m = re.exec(value);
	while (m !== null) {
		out.push(parseMentionMatch(m));
		m = re.exec(value);
	}
	return out;
}

describe('parseMentionMatch', () => {
	it('maps each alternation branch to its token kind', () => {
		const tokens = tokensOf(
			`@@product-lead and @captain should read TO-1, IN-42#comment-${UUID}, prd.md and assets/mock.png`,
		);
		expect(tokens).toEqual([
			{ kind: 'passive_agent', raw: '@@product-lead', slug: 'product-lead' },
			{ kind: 'agent', raw: '@captain', slug: 'captain' },
			{ kind: 'task', raw: 'TO-1', identifier: 'to-1' },
			{ kind: 'comment', raw: `IN-42#comment-${UUID}`, taskIdentifier: 'in-42', commentId: UUID },
			{ kind: 'filename', raw: 'prd.md', filename: 'prd.md' },
			{ kind: 'asset', raw: 'assets/mock.png', filename: 'mock.png' },
		]);
	});

	it('keeps raw text exact-case while lowercasing slugs and identifiers', () => {
		const [token] = tokensOf('see TO-7');
		expect(token).toEqual({ kind: 'task', raw: 'TO-7', identifier: 'to-7' });
	});

	it('does not treat a non-UUID comment suffix as a comment link', () => {
		const tokens = tokensOf('IN-42#comment-foo');
		expect(tokens[0]).toEqual({ kind: 'task', raw: 'IN-42', identifier: 'in-42' });
	});
});

describe('extractMentionCandidates', () => {
	it('collects deduped candidates per kind', () => {
		const c = extractMentionCandidates(
			`TO-1 again TO-1 and to boot IN-42#comment-${UUID}; ask @captain or @@captain about prd.md and assets/a.png`,
		);
		expect(c.tasks.sort()).toEqual(['in-42', 'to-1']);
		expect(c.filenames).toEqual(['prd.md']);
		expect(c.assets).toEqual(['a.png']);
		expect(c.agents).toEqual(['captain']);
	});

	it('excludes @admin and ignores references inside code', () => {
		const c = extractMentionCandidates(
			'ping @admin about `TO-9` and\n```\nIN-3 spec.md @captain\n```\nplus TO-2',
		);
		expect(c.agents).toEqual([]);
		expect(c.tasks).toEqual(['to-2']);
		expect(c.filenames).toEqual([]);
	});
});

describe('transformMentionsOutsideCode', () => {
	const linkTasks = (token: MentionToken) =>
		token.kind === 'task' ? `[${token.raw}](https://x.test/t/${token.identifier})` : null;

	it('replaces tokens outside code and preserves everything else byte-for-byte', () => {
		const input = 'Look at TO-1 (and TO-2), please.';
		expect(transformMentionsOutsideCode(input, linkTasks)).toBe(
			'Look at [TO-1](https://x.test/t/to-1) (and [TO-2](https://x.test/t/to-2)), please.',
		);
	});

	it('leaves inline code and fences untouched', () => {
		const input = 'TO-1 then `TO-2` and\n```\nTO-3\n```\n~~~\nTO-5\n~~~\nthen TO-4';
		expect(transformMentionsOutsideCode(input, linkTasks)).toBe(
			'[TO-1](https://x.test/t/to-1) then `TO-2` and\n```\nTO-3\n```\n~~~\nTO-5\n~~~\nthen [TO-4](https://x.test/t/to-4)',
		);
	});

	it('keeps the original text when the replacer returns null', () => {
		const input = 'TO-1 and prd.md stay put';
		expect(transformMentionsOutsideCode(input, () => null)).toBe(input);
	});
});

describe('entity paths', () => {
	it('builds web-route-shaped paths', () => {
		expect(taskPath('todo6', 'TO-1')).toBe('/projects/todo6/tasks/to-1');
		expect(commentPath('todo6', 'TO-1', UUID)).toBe(`/projects/todo6/tasks/to-1#comment-${UUID}`);
		expect(projectDocPath('todo6', 'prd.md')).toBe('/projects/todo6/documents?file=prd.md');
		expect(assetPath('todo6', 'a b.png')).toBe('/projects/todo6/assets?file=a%20b.png');
		expect(agentPath('hq', 'ceo')).toBe('/projects/hq/agents/ceo');
		expect(projectInboxPath('todo6')).toBe('/projects/todo6/inbox');
	});
});
