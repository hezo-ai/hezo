import { describe, expect, it } from 'vitest';
// Repo tooling under scripts/ — imported directly (pure functions, no DB/DOM),
// same pattern as coverage-lcov.test.ts.
import {
	checkCommitMessage,
	docBearingFiles,
	effectiveMessage,
	findDocsAckValue,
	isExemptCommit,
} from '../../../scripts/check-docs-ack';

const ACK = 'Docs-Checked: verified docs/reference/cli.md still matches the flag set';

describe('docBearingFiles', () => {
	it('flags source, migrations, agents, skills, docker, deploy, marketplace, and scripts', () => {
		const files = [
			'packages/server/src/cli.ts',
			'packages/server/migrations/017_example.sql',
			'agents/blank/captain.md',
			'skills/debugging.md',
			'docker/Dockerfile.agent-base',
			'deploy/provision.sh',
			'marketplace/teams/software-development.json',
			'scripts/test.ts',
		];
		expect(docBearingFiles(files)).toEqual(files);
	});

	it('exempts docs, tests, CI config, and repo-root prose', () => {
		expect(
			docBearingFiles([
				'docs/concepts/tasks.md',
				'packages/server/test/tasks.test.ts',
				'packages/web/test/task-create.test.tsx',
				'test/browser/task-deep-link-scroll.spec.ts',
				'.github/workflows/ci.yml',
				'AGENTS.md',
				'README.md',
				'.dev/architecture.md',
			]),
		).toEqual([]);
	});
});

describe('effectiveMessage / isExemptCommit', () => {
	it('strips comment lines and scissors content', () => {
		const raw = [
			'feat: add thing',
			'',
			'# Please enter the commit message',
			'body line',
			'# ------------------------ >8 ------------------------',
			'diff --git a/x b/x',
		].join('\n');
		const msg = effectiveMessage(raw);
		expect(msg).toContain('body line');
		expect(msg).not.toContain('Please enter');
		expect(msg).not.toContain('diff --git');
	});

	it('exempts merge, revert, and fixup commits', () => {
		expect(isExemptCommit('Merge branch main into feature')).toBe(true);
		expect(isExemptCommit('Revert "feat: add thing"')).toBe(true);
		expect(isExemptCommit('fixup! feat: add thing')).toBe(true);
		expect(isExemptCommit('feat: add thing')).toBe(false);
	});
});

describe('findDocsAckValue', () => {
	it('finds the trailer case-insensitively and trims the value', () => {
		expect(findDocsAckValue('feat: x\n\ndocs-checked:  updated docs/foo.md  ')).toBe(
			'updated docs/foo.md',
		);
	});

	it('returns null when absent', () => {
		expect(findDocsAckValue('feat: x\n\nSome body')).toBeNull();
	});
});

describe('checkCommitMessage', () => {
	it('rejects a code commit with no trailer', () => {
		const r = checkCommitMessage('feat: add flag', ['packages/server/src/cli.ts']);
		expect(r.ok).toBe(false);
		expect(r.error).toContain('Docs-Checked');
	});

	it('rejects bare and too-short acknowledgments', () => {
		for (const value of ['yes', 'n/a', 'done', 'ok', 'checked!']) {
			const r = checkCommitMessage(`feat: add flag\n\nDocs-Checked: ${value}`, [
				'packages/server/src/cli.ts',
			]);
			expect(r.ok).toBe(false);
		}
	});

	it('accepts a meaningful acknowledgment on a code commit', () => {
		const r = checkCommitMessage(`feat: add flag\n\n${ACK}`, ['packages/server/src/cli.ts']);
		expect(r.ok).toBe(true);
	});

	it('passes docs-only and test-only commits without a trailer', () => {
		expect(checkCommitMessage('docs: fix typo', ['docs/concepts/tasks.md']).ok).toBe(true);
		expect(
			checkCommitMessage('test: cover edge case', ['packages/server/test/tasks.test.ts']).ok,
		).toBe(true);
	});

	it('passes merge and revert commits touching code', () => {
		expect(checkCommitMessage('Merge branch main', ['packages/server/src/cli.ts']).ok).toBe(true);
		expect(checkCommitMessage('Revert "feat: x"', ['packages/server/src/cli.ts']).ok).toBe(true);
	});
});
