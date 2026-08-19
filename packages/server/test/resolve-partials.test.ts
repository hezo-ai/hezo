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
	it('seeds the binary Captain/instance prompts with the shared partials expanded', async () => {
		// loadAgentRoles now only carries the roles that stay in the binary: the Blank
		// Captain and the instance singletons (CEO/Coach). The specialist roster prompts
		// (app-dev/*) moved to the marketplace and are covered by the
		// marketplace build test — see marketplace-build coverage.
		const docs = await loadAgentRoles();

		const blankCaptain = docs['blank/captain.md'];
		expect(blankCaptain).toBeDefined();
		expect(blankCaptain).toContain('Every run you take is at **max effort**');
		expect(blankCaptain).toContain('## Hire workflow');
		expect(blankCaptain).toContain('Ask before you write.');
		expect(blankCaptain).not.toContain('{{> partials/');

		// The instance CEO/Coach prompts are still bundled and partial-expanded.
		expect(docs['_instance/ceo.md']).toBeDefined();
		expect(docs['_instance/ceo.md']).not.toContain('{{> partials/');
		expect(docs['_instance/coach.md']).toBeDefined();
		expect(docs['_instance/coach.md']).not.toContain('{{> partials/');

		// Partial files themselves are stripped from the returned map
		expect(Object.keys(docs).some((k) => k.startsWith('_partials/'))).toBe(false);
	});
});
