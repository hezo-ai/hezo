import { describe, expect, it } from 'vitest';
import { extractReleaseNotes, renderChangelog } from '../../src/release/changelog';
import type { ParsedCommit } from '../../src/release/conventional';

function commit(overrides: Partial<ParsedCommit>): ParsedCommit {
	return {
		type: 'feat',
		scope: null,
		breaking: false,
		description: 'something',
		hash: 'h',
		pr: null,
		...overrides,
	};
}

const REPO = 'https://github.com/hezo-ai/hezo';

describe('renderChangelog', () => {
	it('renders a heading with the version and date', () => {
		const out = renderChangelog({
			version: '0.1.0',
			date: '2026-06-02',
			commits: [commit({ type: 'feat', description: 'a feature' })],
			previousTag: null,
		});
		expect(out).toContain('## 0.1.0 - 2026-06-02');
	});

	it('groups commits under their section headings in order', () => {
		const out = renderChangelog({
			version: '1.0.0',
			date: '2026-06-02',
			commits: [
				commit({ type: 'fix', description: 'a bug' }),
				commit({ type: 'feat', description: 'a feature' }),
			],
			previousTag: '0.9.0',
		});
		expect(out).toContain('### Features');
		expect(out).toContain('### Bug Fixes');
		expect(out).toContain('- a feature');
		expect(out).toContain('- a bug');
		// Features section comes before Bug Fixes
		expect(out.indexOf('### Features')).toBeLessThan(out.indexOf('### Bug Fixes'));
	});

	it('omits empty sections', () => {
		const out = renderChangelog({
			version: '1.0.1',
			date: '2026-06-02',
			commits: [commit({ type: 'fix', description: 'a bug' })],
			previousTag: '1.0.0',
		});
		expect(out).not.toContain('### Features');
		expect(out).toContain('### Bug Fixes');
	});

	it('places a Breaking Changes section above the rest', () => {
		const out = renderChangelog({
			version: '2.0.0',
			date: '2026-06-02',
			commits: [
				commit({ type: 'feat', description: 'normal feature' }),
				commit({ type: 'feat', breaking: true, description: 'removed thing' }),
			],
			previousTag: '1.5.0',
		});
		expect(out).toContain('### Breaking Changes');
		expect(out.indexOf('### Breaking Changes')).toBeLessThan(out.indexOf('### Features'));
		// The breaking commit also appears in its type section.
		expect(out).toContain('- normal feature');
	});

	it('formats scope and PR with a link when a repo url is given', () => {
		const out = renderChangelog({
			version: '1.1.0',
			date: '2026-06-02',
			commits: [commit({ type: 'feat', scope: 'projects', description: 'add assets', pr: 105 })],
			previousTag: '1.0.0',
			repoUrl: REPO,
		});
		expect(out).toContain(
			'- **projects:** add assets ([#105](https://github.com/hezo-ai/hezo/pull/105))',
		);
	});

	it('formats PR without a link when no repo url is given', () => {
		const out = renderChangelog({
			version: '1.1.0',
			date: '2026-06-02',
			commits: [commit({ type: 'feat', description: 'add assets', pr: 105 })],
			previousTag: '1.0.0',
		});
		expect(out).toContain('- add assets (#105)');
	});

	it('uses a compare link when there is a previous tag', () => {
		const out = renderChangelog({
			version: '1.1.0',
			date: '2026-06-02',
			commits: [commit({})],
			previousTag: '1.0.0',
			repoUrl: REPO,
		});
		expect(out).toContain(`**Full Changelog**: ${REPO}/compare/1.0.0...1.1.0`);
	});

	it('uses a commits link for the first release', () => {
		const out = renderChangelog({
			version: '0.1.0',
			date: '2026-06-02',
			commits: [commit({})],
			previousTag: null,
			repoUrl: REPO,
		});
		expect(out).toContain(`**Full Changelog**: ${REPO}/commits/0.1.0`);
	});

	it('buckets non-conventional/unknown types under Other', () => {
		const out = renderChangelog({
			version: '1.0.1',
			date: '2026-06-02',
			commits: [
				commit({ type: '', description: 'random commit' }),
				commit({ type: 'wip', description: 'unknown type' }),
			],
			previousTag: '1.0.0',
		});
		expect(out).toContain('### Other');
		expect(out).toContain('- random commit');
		expect(out).toContain('- unknown type');
	});
});

const SAMPLE_CHANGELOG = `# Changelog

## 1.1.0 - 2026-06-10

### Features

- a new thing (#10)

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/1.0.0...1.1.0

## 1.0.0 - 2026-06-01

### Bug Fixes

- an old fix (#1)
`;

describe('extractReleaseNotes', () => {
	it('extracts the latest version section without the heading', () => {
		const notes = extractReleaseNotes(SAMPLE_CHANGELOG, '1.1.0');
		expect(notes).toContain('### Features');
		expect(notes).toContain('- a new thing (#10)');
		expect(notes).toContain('**Full Changelog**');
		// Stops before the previous version and drops its own heading. (The
		// compare link legitimately mentions 1.0.0, so assert on section content.)
		expect(notes).not.toContain('## 1.1.0');
		expect(notes).not.toContain('## 1.0.0');
		expect(notes).not.toContain('### Bug Fixes');
		expect(notes).not.toContain('an old fix');
	});

	it('extracts a trailing (oldest) version section through end of file', () => {
		const notes = extractReleaseNotes(SAMPLE_CHANGELOG, '1.0.0');
		expect(notes).toContain('### Bug Fixes');
		expect(notes).toContain('- an old fix (#1)');
	});

	it('returns null when the version is absent', () => {
		expect(extractReleaseNotes(SAMPLE_CHANGELOG, '9.9.9')).toBeNull();
	});

	it('does not prefix-match a longer version', () => {
		const cl = '# Changelog\n\n## 1.2.10 - 2026-06-10\n\n### Features\n\n- ten\n';
		expect(extractReleaseNotes(cl, '1.2.1')).toBeNull();
	});
});
