import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// Repo tooling under scripts/ — imported directly (pure functions, no DB/DOM),
// same pattern as docs-ack-hook.test.ts.
import {
	checkDocsTree,
	classifyExternalStatus,
	docsPathToFile,
	extractLinks,
	headingAnchors,
	isSkippedExternalUrl,
	selfRepoPath,
	slugifyHeading,
	stripCode,
} from '../../../scripts/check-docs-links';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

describe('slugifyHeading', () => {
	it('matches the GitHub slugger on the anchor shapes the docs actually link', () => {
		expect(slugifyHeading('Managed database & asset storage')).toBe(
			'managed-database--asset-storage',
		);
		expect(slugifyHeading('HQ - the home team')).toBe('hq---the-home-team');
		expect(slugifyHeading('Connecting an OAuth API with the device flow (no callback)')).toBe(
			'connecting-an-oauth-api-with-the-device-flow-no-callback',
		);
		expect(slugifyHeading('Switching at any time')).toBe('switching-at-any-time');
	});

	it('strips emphasis and code markers but keeps their text', () => {
		expect(slugifyHeading('Using `--foo`')).toBe('using---foo');
		expect(slugifyHeading('**Bold** heading')).toBe('bold-heading');
	});
});

describe('headingAnchors', () => {
	it('collects every heading level, suffixes duplicates, and skips fenced blocks', () => {
		const anchors = headingAnchors(
			['# Top', '## Same', '## Same', '```', '## Not a heading', '```'].join('\n'),
		);
		expect(anchors).toEqual(new Set(['top', 'same', 'same-1']));
	});
});

describe('stripCode / extractLinks', () => {
	it('ignores links inside fenced blocks and inline code, preserving line numbers', () => {
		const md = [
			'intro',
			'```sh',
			'curl [not a link](http://localhost:3100)',
			'```',
			'see `[also not](/docs/nope)` and [real](/docs/introduction).',
		].join('\n');
		expect(stripCode(md)).not.toContain('/docs/nope');
		const links = extractLinks(md);
		expect(links).toEqual([{ target: '/docs/introduction', line: 5 }]);
	});

	it('extracts images and multiple links per line', () => {
		const links = extractLinks('![alt](../assets/x.png) then [a](/docs/a) and [b](/docs/b)');
		expect(links.map((l) => l.target)).toEqual(['../assets/x.png', '/docs/a', '/docs/b']);
	});
});

describe('target classification', () => {
	it('maps /docs paths to markdown files', () => {
		expect(docsPathToFile('/docs/containers/overview')).toBe('docs/containers/overview.md');
		expect(docsPathToFile('/docs/containers/overview/')).toBe('docs/containers/overview.md');
		expect(docsPathToFile('/docs')).toBe('docs/introduction.md');
	});

	it('recognises links into this repo', () => {
		expect(selfRepoPath('https://github.com/hezo-ai/hezo/blob/main/agents/blank/captain.md')).toBe(
			'agents/blank/captain.md',
		);
		expect(selfRepoPath('https://github.com/hezo-ai/hezo/blob/main/deploy/provision.sh#L3')).toBe(
			'deploy/provision.sh',
		);
		expect(selfRepoPath('https://github.com/hezo-ai/hezo/releases/latest')).toBeNull();
		expect(selfRepoPath('https://github.com/other/repo/blob/main/x.md')).toBeNull();
	});

	it('skips example hosts and blocks only on definitive statuses', () => {
		expect(isSkippedExternalUrl('http://localhost:3100/SKILL.md')).toBe(true);
		expect(isSkippedExternalUrl('http://host.docker.internal:11434')).toBe(true);
		expect(isSkippedExternalUrl('https://api.example.com/x')).toBe(true);
		expect(isSkippedExternalUrl('https://www.daytona.io')).toBe(false);
		expect(classifyExternalStatus(404)).toBe('broken');
		expect(classifyExternalStatus(410)).toBe('broken');
		expect(classifyExternalStatus(200)).toBe('ok');
		expect(classifyExternalStatus(302)).toBe('ok');
		// A 403 can be a bot wall in front of a perfectly good page.
		expect(classifyExternalStatus(403)).toBe('unreachable');
		expect(classifyExternalStatus(503)).toBe('unreachable');
	});
});

describe('checkDocsTree', () => {
	const exists = () => false;

	it('reports a link to a missing page, a bad anchor, and a bad relative path', () => {
		const files = new Map<string, string>([
			['docs/a.md', '# A\n\n## Real heading\n\n[gone](/docs/missing) [bad](/docs/b#nope)'],
			['docs/b.md', '# B\n\n[img](../assets/nope.png) [ok self](#b)'],
		]);
		const problems = checkDocsTree(files, exists);
		expect(problems).toHaveLength(3);
		expect(problems[0]).toContain('docs/a.md:5');
		expect(problems[0]).toContain('/docs/missing');
		expect(problems[1]).toContain('broken anchor /docs/b#nope');
		expect(problems[2]).toContain('broken relative link ../assets/nope.png');
	});

	it('accepts valid pages, anchors, same-file anchors and repo links that exist', () => {
		const files = new Map<string, string>([
			['docs/a.md', '# A\n\n[b](/docs/b#real-heading) [self](#a)'],
			['docs/b.md', '# B\n\n## Real heading\n\ntext'],
		]);
		expect(checkDocsTree(files, () => true)).toEqual([]);
	});
});

describe('the real docs tree', () => {
	it('has no broken internal links, anchors, or repo-file links', () => {
		const files = new Map<string, string>();
		const walk = (dir: string) => {
			for (const entry of readdirSync(join(repoRoot, dir), { withFileTypes: true })) {
				const rel = `${dir}/${entry.name}`;
				if (entry.isDirectory()) walk(rel);
				else if (entry.name.endsWith('.md'))
					files.set(rel, readFileSync(join(repoRoot, rel), 'utf8'));
			}
		};
		walk('docs');
		expect(files.size).toBeGreaterThan(40);
		const problems = checkDocsTree(files, (p) => existsSync(join(repoRoot, p)));
		expect(problems).toEqual([]);
	});
});
