import { describe, expect, it } from 'vitest';
import { loadAgentRoles } from '../src/db/agent-roles';
import { PartialResolutionError, resolvePartials } from '../src/db/resolve-partials';

describe('resolvePartials', () => {
	it('inlines a top-level partial into a role doc', () => {
		const out = resolvePartials({
			'_partials/greet.md': 'Hello.',
			'blank/captain.md': 'Intro.\n{{> partials/greet}}\nOutro.',
		});
		expect(out['blank/captain.md']).toBe('Intro.\nHello.\nOutro.');
		expect(out['_partials/greet.md']).toBeUndefined();
	});

	it('resolves partials nested inside other partials', () => {
		const out = resolvePartials({
			'_partials/inner.md': 'inner',
			'_partials/outer.md': 'A\n{{> partials/inner}}\nB',
			'blank/captain.md': '{{> partials/outer}}',
		});
		expect(out['blank/captain.md']).toBe('A\ninner\nB');
	});

	it('tolerates leading and trailing whitespace around the directive', () => {
		const out = resolvePartials({
			'_partials/x.md': 'BODY',
			'blank/captain.md': '  {{> partials/x}}  ',
		});
		expect(out['blank/captain.md']).toBe('BODY');
	});

	it('does not expand directives embedded mid-line (treats them as literal)', () => {
		const out = resolvePartials({
			'_partials/x.md': 'BODY',
			'blank/captain.md': 'prefix {{> partials/x}} suffix',
		});
		expect(out['blank/captain.md']).toBe('prefix {{> partials/x}} suffix');
	});

	it('throws on an unknown partial reference', () => {
		expect(() =>
			resolvePartials({
				'blank/captain.md': '{{> partials/missing}}',
			}),
		).toThrow(PartialResolutionError);
	});

	it('throws on a partial cycle', () => {
		expect(() =>
			resolvePartials({
				'_partials/a.md': '{{> partials/b}}',
				'_partials/b.md': '{{> partials/a}}',
				'blank/captain.md': '{{> partials/a}}',
			}),
		).toThrow(/cycle/);
	});

	it('leaves role docs without directives unchanged', () => {
		const untouched = 'Plain doc with no partials.';
		const out = resolvePartials({ 'blank/captain.md': untouched });
		expect(out['blank/captain.md']).toBe(untouched);
	});
});

describe('loadAgentRoles integrates resolvePartials', () => {
	it('seeds Captain prompts from both templates with the shared partials expanded', async () => {
		const docs = await loadAgentRoles();

		const sdCeo = docs['software-development/captain.md'];
		expect(sdCeo).toBeDefined();
		expect(sdCeo).toContain('Every run you take is at **max effort**');
		expect(sdCeo).toContain('## Hire workflow');
		expect(sdCeo).toContain('Ask before you write.');
		// the captain.md fan-out body edit must reach the prompt
		expect(sdCeo).toContain('Fan out only to your direct reports');
		expect(sdCeo).not.toContain('{{> partials/');

		const blankCeo = docs['blank/captain.md'];
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

		// The planning-ticket-children partial still expands where it is used (Captain).
		expect(sdCeo).toContain('## Draft execution plan tickets (`planning` label)');

		// Partial files themselves are stripped from the returned map
		expect(Object.keys(docs).some((k) => k.startsWith('_partials/'))).toBe(false);
	});
});
