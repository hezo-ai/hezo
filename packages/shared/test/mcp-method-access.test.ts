import { describe, expect, it } from 'vitest';
import {
	classifyMcpMethod,
	classifyMcpMethods,
	isReadOnlyRestricted,
	type McpMethodInfo,
	readOnlyMethodNames,
	summarizeMethodAccess,
} from '../src/mcp/method-access';

describe('classifyMcpMethod', () => {
	it("takes the server's readOnlyHint over the name heuristic, in both directions", () => {
		// A name that reads as mutating, declared read-only by the server.
		const declaredRead = classifyMcpMethod({
			name: 'save_search_preset',
			annotations: { readOnlyHint: true },
		});
		expect(declaredRead.readOnly).toBe(true);
		expect(declaredRead.inferred).toBe(false);

		// A name that reads as safe, declared mutating by the server. This is the
		// direction that matters: the heuristic would have granted it.
		const declaredWrite = classifyMcpMethod({
			name: 'get_and_lock_record',
			annotations: { readOnlyHint: false },
		});
		expect(declaredWrite.readOnly).toBe(false);
		expect(declaredWrite.inferred).toBe(false);
	});

	it('falls back to the leading word when no hint is declared', () => {
		for (const name of ['list_issues', 'get_issue', 'search_documentation', 'fetch_diff']) {
			const m = classifyMcpMethod({ name });
			expect(m.readOnly, name).toBe(true);
			expect(m.inferred, name).toBe(true);
		}
	});

	it('treats an unrecognised leading word as a write method', () => {
		// The heuristic is a read allowlist, so anything it does not recognise —
		// including a verb it has never seen — must land in the write category.
		for (const name of ['save_issue', 'merge_diff', 'frobnicate_widget', 'issue']) {
			const m = classifyMcpMethod({ name });
			expect(m.readOnly, name).toBe(false);
			expect(m.inferred, name).toBe(true);
		}
	});

	it('recognises the read prefix across naming conventions', () => {
		for (const name of ['listIssues', 'list-issues', 'ListIssues', 'list.issues', 'list issues']) {
			expect(classifyMcpMethod({ name }).readOnly, name).toBe(true);
		}
	});

	it('does not treat a longer word that merely starts with a read prefix as read-only', () => {
		// "getaway" starts with "get" but is not "get" — prefix matching on raw
		// characters would misclassify it, word splitting does not.
		expect(classifyMcpMethod({ name: 'getaway_delete' }).readOnly).toBe(false);
		expect(classifyMcpMethod({ name: 'listen_for_events' }).readOnly).toBe(false);
	});

	it('carries the description through and omits it when absent', () => {
		expect(classifyMcpMethod({ name: 'get_issue', description: 'Fetch one issue' })).toEqual({
			name: 'get_issue',
			description: 'Fetch one issue',
			readOnly: true,
			inferred: true,
		});
		expect(classifyMcpMethod({ name: 'get_issue' })).toEqual({
			name: 'get_issue',
			readOnly: true,
			inferred: true,
		});
	});

	it('preserves server ordering when classifying a whole list', () => {
		const out = classifyMcpMethods([{ name: 'save_issue' }, { name: 'get_issue' }]);
		expect(out.map((m) => m.name)).toEqual(['save_issue', 'get_issue']);
	});
});

describe('classifyMcpMethods — vendor-namespaced catalogs', () => {
	it('classifies on the verb after a namespace every tool shares', () => {
		// The real shape that broke this: Typefully names every tool after itself,
		// so the leading word is the vendor and the prefix table saw a catalog with
		// no read method anywhere in it.
		const out = classifyMcpMethods([
			{ name: 'typefully_list_drafts' },
			{ name: 'typefully_get_me' },
			{ name: 'typefully_create_draft' },
			{ name: 'typefully_delete_draft' },
		]);
		expect(out.map((m) => m.readOnly)).toEqual([true, true, false, false]);
		// Still a guess, not a declaration.
		expect(out.every((m) => m.inferred)).toBe(true);
		expect(readOnlyMethodNames(out)).toEqual(['typefully_list_drafts', 'typefully_get_me']);
	});

	it('leaves the name untouched — only the classification changes', () => {
		const [first] = classifyMcpMethods([
			{ name: 'typefully_get_me', description: 'Who am I' },
			{ name: 'typefully_create_draft' },
		]);
		expect(first).toEqual({
			name: 'typefully_get_me',
			description: 'Who am I',
			readOnly: true,
			inferred: true,
		});
	});

	it('requires every tool to share the token, since a partial match is a coincidence', () => {
		const out = classifyMcpMethods([{ name: 'typefully_list_drafts' }, { name: 'get_me' }]);
		// No namespace inferred, so `typefully` is read as the verb and falls through
		// to write - the historic, deliberately strict behaviour.
		expect(out[0]?.readOnly).toBe(false);
		expect(out[1]?.readOnly).toBe(true);
	});

	it('refuses to strip a shared token that is itself a read prefix', () => {
		// A server whose tools are all `list_*` is naming them consistently, not
		// namespacing them. Stripping `list` would leave `drafts`/`tags` and turn a
		// wholly read-only catalog into a wholly write one.
		const out = classifyMcpMethods([{ name: 'list_drafts' }, { name: 'list_tags' }]);
		expect(out.map((m) => m.readOnly)).toEqual([true, true]);
	});

	it('cannot infer a namespace from a single tool', () => {
		// One name gives no way to tell a vendor prefix from a verb, so it stays
		// strict.
		expect(classifyMcpMethods([{ name: 'typefully_get_me' }])[0]?.readOnly).toBe(false);
	});

	it('does not infer a namespace when any tool is a bare single word', () => {
		const out = classifyMcpMethods([{ name: 'typefully' }, { name: 'typefully_get_me' }]);
		expect(out.map((m) => m.readOnly)).toEqual([false, false]);
	});

	it("still lets the server's readOnlyHint override the namespace-aware guess", () => {
		const out = classifyMcpMethods([
			{ name: 'typefully_get_or_lock_draft', annotations: { readOnlyHint: false } },
			{ name: 'typefully_create_draft' },
		]);
		expect(out[0]?.readOnly).toBe(false);
		expect(out[0]?.inferred).toBe(false);
	});

	it('handles camelCase namespacing too', () => {
		const out = classifyMcpMethods([{ name: 'typefullyListDrafts' }, { name: 'typefullyGetMe' }]);
		expect(out.map((m) => m.readOnly)).toEqual([true, true]);
	});
});

const CATALOG: McpMethodInfo[] = [
	{ name: 'get_issue', readOnly: true, inferred: false },
	{ name: 'list_issues', readOnly: true, inferred: false },
	{ name: 'search_docs', readOnly: true, inferred: true },
	{ name: 'save_issue', readOnly: false, inferred: false },
	{ name: 'delete_comment', readOnly: false, inferred: true },
];

describe('summarizeMethodAccess', () => {
	it('reports mode "all" and every method enabled when there is no allowlist', () => {
		expect(summarizeMethodAccess(CATALOG, null)).toEqual({
			mode: 'all',
			total: 5,
			enabled: 5,
			readOnlyTotal: 3,
			readOnlyEnabled: 3,
			writeTotal: 2,
			writeEnabled: 2,
			writeDisabled: 0,
		});
	});

	it('counts a read-only restriction', () => {
		const s = summarizeMethodAccess(CATALOG, ['get_issue', 'list_issues', 'search_docs']);
		expect(s.mode).toBe('restricted');
		expect(s.enabled).toBe(3);
		expect(s.readOnlyEnabled).toBe(3);
		expect(s.writeEnabled).toBe(0);
		expect(s.writeDisabled).toBe(2);
	});

	it('counts a partial restriction that keeps some write methods', () => {
		const s = summarizeMethodAccess(CATALOG, ['get_issue', 'save_issue']);
		expect(s.enabled).toBe(2);
		expect(s.readOnlyEnabled).toBe(1);
		expect(s.writeEnabled).toBe(1);
		expect(s.writeDisabled).toBe(1);
	});

	it('is restricted-with-nothing-enabled for an empty allowlist, not unrestricted', () => {
		// An empty array and null are very different: [] disables everything.
		const s = summarizeMethodAccess(CATALOG, []);
		expect(s.mode).toBe('restricted');
		expect(s.enabled).toBe(0);
	});

	it('ignores allowlist entries the catalog no longer advertises', () => {
		const s = summarizeMethodAccess(CATALOG, ['get_issue', 'removed_by_the_server']);
		expect(s.enabled).toBe(1);
		expect(s.total).toBe(5);
	});

	it('handles an empty catalog', () => {
		const s = summarizeMethodAccess([], null);
		expect(s).toEqual({
			mode: 'all',
			total: 0,
			enabled: 0,
			readOnlyTotal: 0,
			readOnlyEnabled: 0,
			writeTotal: 0,
			writeEnabled: 0,
			writeDisabled: 0,
		});
	});
});

describe('readOnlyMethodNames', () => {
	it('resolves an agent read-access request to the read-only names', () => {
		expect(readOnlyMethodNames(CATALOG)).toEqual(['get_issue', 'list_issues', 'search_docs']);
	});

	it('is empty for a catalog with no read-only methods', () => {
		expect(readOnlyMethodNames([{ name: 'save_issue', readOnly: false, inferred: false }])).toEqual(
			[],
		);
	});
});

describe('isReadOnlyRestricted', () => {
	it('is true only when every write method is disabled', () => {
		expect(isReadOnlyRestricted(CATALOG, ['get_issue', 'list_issues', 'search_docs'])).toBe(true);
		expect(isReadOnlyRestricted(CATALOG, ['get_issue', 'save_issue'])).toBe(false);
	});

	it('is false with no allowlist', () => {
		expect(isReadOnlyRestricted(CATALOG, null)).toBe(false);
	});

	it('is false when the server exposes no write methods at all', () => {
		// Nothing was withheld, so calling it "read-only" would overstate it.
		const readOnlyServer: McpMethodInfo[] = [
			{ name: 'get_issue', readOnly: true, inferred: false },
		];
		expect(isReadOnlyRestricted(readOnlyServer, ['get_issue'])).toBe(false);
	});
});
