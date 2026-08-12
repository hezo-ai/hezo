import { describe, expect, it } from 'vitest';
import {
	checkFiles,
	findCrossFileDuplicates,
	isMarketplaceReaching,
	promptFiles,
} from '../../../scripts/check-prompt-style';
import {
	checkCommitMessage,
	findPromptsAckValue,
	PROMPT_BEARING_PATTERNS,
	promptBearingFiles,
} from '../../../scripts/check-prompts-ack';

/**
 * Guard for the `Prompts-Checked:` commit hook and its mechanical sibling.
 * Mirrors docs-ack-hook.test.ts - same shared machinery, different bearing
 * paths and a different obligation.
 */
describe('prompt-bearing classification', () => {
	it('covers the four surfaces that carry agent-facing prose', () => {
		expect(
			promptBearingFiles([
				'agents/software-development/engineer.md',
				'agents/_partials/common/repo-work.md',
				'skills/code-review.md',
				'marketplace/teams/investment.json',
				'packages/server/src/services/template-resolver.ts',
			]),
		).toHaveLength(5);
	});

	it('ignores everything else, including tests and docs', () => {
		expect(
			promptBearingFiles([
				'packages/server/test/agent-types.test.ts',
				'packages/web/src/routes/index.tsx',
				'docs/concepts/tasks.md',
				'.dev/writing-agent-prompts.md',
				'packages/server/src/services/agent-runner.ts',
			]),
		).toEqual([]);
	});

	it('matches template-resolver.ts exactly, not by prefix', () => {
		const hit = (f: string) => PROMPT_BEARING_PATTERNS.some((p) => p.test(f));
		expect(hit('packages/server/src/services/template-resolver.ts')).toBe(true);
		expect(hit('packages/server/test/template-resolver.test.ts')).toBe(false);
	});
});

describe('the Prompts-Checked trailer', () => {
	const staged = ['agents/software-development/engineer.md'];

	it('rejects a prompt commit with no trailer', () => {
		const r = checkCommitMessage('refactor(prompts): tighten the engineer prompt', staged);
		expect(r.ok).toBe(false);
		expect(r.error).toContain('Prompts-Checked');
	});

	it('rejects a rubber stamp', () => {
		const r = checkCommitMessage('refactor(prompts): x\n\nPrompts-Checked: yes', staged);
		expect(r.ok).toBe(false);
		expect(r.error).toContain('not a meaningful acknowledgment');
	});

	it('accepts a real acknowledgment', () => {
		const r = checkCommitMessage(
			'refactor(prompts): x\n\nPrompts-Checked: rewrote the workflow to the register; no rule duplicated',
			staged,
		);
		expect(r.ok).toBe(true);
	});

	it('leaves a commit touching no prompt alone', () => {
		expect(checkCommitMessage('fix: unrelated', ['packages/web/src/main.tsx']).ok).toBe(true);
	});

	it('exempts merges, reverts and fixups', () => {
		for (const msg of ['Merge branch main', 'Revert "x"', 'fixup! earlier']) {
			expect(checkCommitMessage(msg, staged).ok, msg).toBe(true);
		}
	});

	it('reads the trailer case-insensitively, anywhere in the body', () => {
		expect(findPromptsAckValue('title\n\nprompts-checked: did the pass properly')).toBe(
			'did the pass properly',
		);
	});
});

describe('marketplace reach', () => {
	it('treats team docs and partials as shipping to other repositories', () => {
		expect(isMarketplaceReaching('agents/software-development/engineer.md')).toBe(true);
		expect(isMarketplaceReaching('agents/_partials/common/code-quality-principles.md')).toBe(true);
	});

	it('treats the instance-only prompts as local', () => {
		expect(isMarketplaceReaching('agents/_instance/ceo.md')).toBe(false);
		expect(isMarketplaceReaching('agents/blank/captain.md')).toBe(false);
		expect(isMarketplaceReaching('skills/code-review.md')).toBe(false);
	});
});

describe('cross-file duplicate detection', () => {
	it('reports a shared bullet against every file carrying it', () => {
		const bullet = '- **Post the active mention.** A passive reference wakes nobody at all.';
		const found = findCrossFileDuplicates([
			{ path: 'agents/a/one.md', content: `# One\n${bullet}\n` },
			{ path: 'agents/a/two.md', content: `# Two\n${bullet}\n` },
		]);
		expect(found.map((f) => f.file).sort()).toEqual(['agents/a/one.md', 'agents/a/two.md']);
		expect(found[0].findings[0].message).toContain('agents/a/two.md');
	});

	it('ignores a bullet that appears twice in one file', () => {
		const bullet = '- **Post the active mention.** A passive reference wakes nobody at all.';
		expect(
			findCrossFileDuplicates([{ path: 'agents/a/one.md', content: `${bullet}\n${bullet}\n` }]),
		).toEqual([]);
	});

	it('ignores bullets too short to match meaningfully', () => {
		expect(
			findCrossFileDuplicates([
				{ path: 'agents/a/one.md', content: '- Do it now.\n' },
				{ path: 'agents/a/two.md', content: '- Do it now.\n' },
			]),
		).toEqual([]);
	});
});

describe('what the linter blocks on', () => {
	it('marks duplication and Hezo internals as errors, length and vocabulary as warnings', () => {
		const results = checkFiles([
			{ path: 'agents/team/a.md', content: '- Wrap it in `withTransaction` before you write.\n' },
			{ path: 'agents/team/b.md', content: `- Generally, ${'word '.repeat(80)}\n` },
		]);
		const bySeverity = (sev: string) =>
			results.flatMap((r) => r.findings.filter((f) => f.severity === sev).map((f) => f.rule));
		expect(bySeverity('error')).toContain('hezo_internal');
		expect(bySeverity('warning')).toContain('hedge');
		expect(bySeverity('error')).not.toContain('hedge');
	});

	it('selects only markdown under the bearing paths', () => {
		expect(
			promptFiles([
				'agents/team/a.md',
				'marketplace/teams/x.json',
				'packages/server/src/services/template-resolver.ts',
			]),
		).toEqual(['agents/team/a.md']);
	});
});
