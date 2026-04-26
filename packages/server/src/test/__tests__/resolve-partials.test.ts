import { describe, expect, it } from 'vitest';
import { loadAgentRoles } from '../../db/agent-roles';
import { PartialResolutionError, resolvePartials } from '../../db/resolve-partials';

describe('resolvePartials', () => {
	it('inlines a top-level partial into a role doc', () => {
		const out = resolvePartials({
			'_partials/greet.md': 'Hello.',
			'blank/ceo.md': 'Intro.\n{{> partials/greet}}\nOutro.',
		});
		expect(out['blank/ceo.md']).toBe('Intro.\nHello.\nOutro.');
		expect(out['_partials/greet.md']).toBeUndefined();
	});

	it('resolves partials nested inside other partials', () => {
		const out = resolvePartials({
			'_partials/inner.md': 'inner',
			'_partials/outer.md': 'A\n{{> partials/inner}}\nB',
			'blank/ceo.md': '{{> partials/outer}}',
		});
		expect(out['blank/ceo.md']).toBe('A\ninner\nB');
	});

	it('tolerates leading and trailing whitespace around the directive', () => {
		const out = resolvePartials({
			'_partials/x.md': 'BODY',
			'blank/ceo.md': '  {{> partials/x}}  ',
		});
		expect(out['blank/ceo.md']).toBe('BODY');
	});

	it('does not expand directives embedded mid-line (treats them as literal)', () => {
		const out = resolvePartials({
			'_partials/x.md': 'BODY',
			'blank/ceo.md': 'prefix {{> partials/x}} suffix',
		});
		expect(out['blank/ceo.md']).toBe('prefix {{> partials/x}} suffix');
	});

	it('throws on an unknown partial reference', () => {
		expect(() =>
			resolvePartials({
				'blank/ceo.md': '{{> partials/missing}}',
			}),
		).toThrow(PartialResolutionError);
	});

	it('throws on a partial cycle', () => {
		expect(() =>
			resolvePartials({
				'_partials/a.md': '{{> partials/b}}',
				'_partials/b.md': '{{> partials/a}}',
				'blank/ceo.md': '{{> partials/a}}',
			}),
		).toThrow(/cycle/);
	});

	it('leaves role docs without directives unchanged', () => {
		const untouched = 'Plain doc with no partials.';
		const out = resolvePartials({ 'blank/ceo.md': untouched });
		expect(out['blank/ceo.md']).toBe(untouched);
	});
});

describe('loadAgentRoles integrates resolvePartials', () => {
	it('seeds CEO prompts from both templates with the shared partials expanded', async () => {
		const docs = await loadAgentRoles();

		const sdCeo = docs['software-development/ceo.md'];
		expect(sdCeo).toBeDefined();
		expect(sdCeo).toContain('Every run you take is at **max effort**');
		expect(sdCeo).toContain('## Hire workflow');
		expect(sdCeo).toContain('Ask before you write.');
		expect(sdCeo).not.toContain('{{> partials/');

		const blankCeo = docs['blank/ceo.md'];
		expect(blankCeo).toBeDefined();
		expect(blankCeo).toContain('Every run you take is at **max effort**');
		expect(blankCeo).toContain('## Hire workflow');
		expect(blankCeo).toContain('Ask before you write.');
		expect(blankCeo).not.toContain('{{> partials/');

		for (const slug of [
			'engineer',
			'qa-engineer',
			'security-engineer',
			'ui-designer',
			'devops-engineer',
		]) {
			const doc = docs[`software-development/${slug}.md`];
			expect(doc, `${slug} should be loaded`).toBeDefined();
			expect(doc, `${slug} should include no-designated-repo rule`).toContain(
				'No designated repo means no run.',
			);
			expect(doc, `${slug} should have no unresolved directives`).not.toContain('{{> partials/');
		}

		// Architect is repo-optional and must not carry the no-designated-repo rule.
		const architectDoc = docs['software-development/architect.md'];
		expect(architectDoc).toBeDefined();
		expect(architectDoc).not.toContain('No designated repo means no run.');
		expect(architectDoc).toContain('You can run without a designated repo.');

		// Every role doc picks up the no-auto-timelines guidance.
		const allRoleKeys = Object.keys(docs).filter(
			(k) => !k.startsWith('_partials/') && k.endsWith('.md'),
		);
		expect(allRoleKeys.length).toBeGreaterThan(0);
		for (const key of allRoleKeys) {
			expect(docs[key], `${key} should include the no-auto-timelines rule`).toContain(
				'Do not invent timelines, deadlines, or weekly schedules.',
			);
		}

		// Every role doc picks up the linking-syntax guidance.
		for (const key of allRoleKeys) {
			expect(docs[key], `${key} should include the linking-syntax rule`).toContain(
				'## Linking to Hezo entities',
			);
			expect(docs[key], `${key} should include a project-doc example`).toContain('spec.md');
			expect(docs[key], `${key} should include a kb-doc example`).toContain('coding-standards.md');
			expect(docs[key], `${key} should include an agent-mention example`).toContain('@engineer');
		}

		// Every role doc picks up the subtask-preference guidance.
		for (const key of allRoleKeys) {
			expect(docs[key], `${key} should include the sub-issue heading`).toContain(
				'## Sub-issues vs top-level tickets',
			);
			expect(docs[key], `${key} should mention the depth-2 cap`).toContain(
				'capped at two levels deep',
			);
			expect(docs[key], `${key} should explain the parent-deliverable distinction`).toContain(
				"## What counts as the parent's deliverable",
			);
			expect(docs[key], `${key} should call out the planning-ticket parent case`).toContain(
				'**Planning ticket parent**',
			);
			expect(docs[key], `${key} should call out the implementation/feature parent case`).toContain(
				'**Implementation / feature / bug-fix parent**',
			);
		}

		// Every role doc picks up the no-redundant-comments guidance so that re-runs
		// without new substance do not re-wake every @-mentioned agent.
		for (const key of allRoleKeys) {
			expect(docs[key], `${key} should include the no-repost heading`).toContain(
				"## Don't repost when nothing changed",
			);
			expect(docs[key], `${key} should reference list_comments for the check`).toContain(
				'`list_comments`',
			);
			expect(docs[key], `${key} should warn about re-waking mentioned agents`).toContain(
				're-wakes every agent you @-mention',
			);
		}

		// Every role doc picks up the duplicate-check guidance before opening a new ticket.
		for (const key of allRoleKeys) {
			expect(docs[key], `${key} should include the duplicate-check heading`).toContain(
				'## Check before you create',
			);
			expect(docs[key], `${key} should reference list_issues for the duplicate check`).toContain(
				'`list_issues`',
			);
		}

		// Partial files themselves are stripped from the returned map
		expect(Object.keys(docs).some((k) => k.startsWith('_partials/'))).toBe(false);
	});
});
