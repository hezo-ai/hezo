import { describe, expect, it } from 'vitest';
import { renderChangelog } from '../../src/release/changelog';
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
