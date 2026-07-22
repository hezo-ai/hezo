import { describe, expect, it } from 'vitest';
import type { ParsedCommit } from '../../src/release/conventional';
import { applyOverride, computeBump, nextVersion } from '../../src/release/version';

function commit(overrides: Partial<ParsedCommit>): ParsedCommit {
	return {
		type: 'fix',
		scope: null,
		breaking: false,
		description: 'x',
		hash: 'h',
		pr: null,
		...overrides,
	};
}

describe('computeBump', () => {
	it('returns none for an empty commit list', () => {
		expect(computeBump([])).toBe('none');
	});

	it('never auto-derives a major bump, even for a breaking change', () => {
		// Major releases are a deliberate human decision and are never automated.
		expect(computeBump([commit({ type: 'feat', breaking: true })])).not.toBe('major');
		expect(computeBump([commit({ type: 'fix', breaking: true })])).not.toBe('major');
	});

	it('does not let a breaking marker escalate the bump (pre-1.0: breaking does not count)', () => {
		// A breaking `feat` is still just a minor (from the type)...
		expect(computeBump([commit({ type: 'fix' }), commit({ type: 'feat', breaking: true })])).toBe(
			'minor',
		);
		// ...and a breaking `fix` stays a patch — the `!` carries no version weight.
		expect(computeBump([commit({ type: 'fix', breaking: true })])).toBe('patch');
	});

	it('returns minor when a feat is present', () => {
		expect(computeBump([commit({ type: 'fix' }), commit({ type: 'feat' })])).toBe('minor');
	});

	it('returns patch for fixes/other types only', () => {
		expect(computeBump([commit({ type: 'fix' }), commit({ type: 'refactor' })])).toBe('patch');
	});

	it('ignores non-conventional commits when deciding patch', () => {
		expect(computeBump([commit({ type: '' })])).toBe('none');
	});
});

describe('applyOverride', () => {
	it('keeps the computed bump for auto', () => {
		expect(applyOverride('minor', 'auto')).toBe('minor');
	});

	it('honors an explicit override over the computed bump', () => {
		expect(applyOverride('patch', 'major')).toBe('major');
		expect(applyOverride('none', 'patch')).toBe('patch');
	});
});

describe('nextVersion', () => {
	it('bumps major', () => {
		expect(nextVersion('1.2.3', 'major')).toBe('2.0.0');
	});

	it('bumps minor', () => {
		expect(nextVersion('1.2.3', 'minor')).toBe('1.3.0');
	});

	it('bumps patch', () => {
		expect(nextVersion('1.2.3', 'patch')).toBe('1.2.4');
	});

	it('yields 0.1.0 for the first non-major release from the initial base', () => {
		expect(nextVersion('0.0.0', 'minor')).toBe('0.1.0');
		expect(nextVersion('0.0.0', 'patch')).toBe('0.1.0');
	});

	it('yields 1.0.0 for a major first release', () => {
		expect(nextVersion('0.0.0', 'major')).toBe('1.0.0');
	});

	it('throws on a none bump', () => {
		expect(() => nextVersion('1.0.0', 'none')).toThrow();
	});

	it('throws on a non-plain-semver previous version', () => {
		expect(() => nextVersion('v1.0.0', 'patch')).toThrow();
	});
});
