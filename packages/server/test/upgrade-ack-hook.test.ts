import { describe, expect, it } from 'vitest';
import {
	checkCommitMessage,
	findUpgradeAckValue,
	UPGRADE_BEARING_PATTERNS,
	upgradeBearingFiles,
} from '../../../scripts/check-upgrade-ack';

/**
 * Guard for the `Upgrade-Checked:` commit hook. Mirrors docs-ack-hook.test.ts -
 * same shared machinery, different bearing paths and a different obligation.
 */
describe('upgrade-bearing classification', () => {
	it('covers the surfaces an already-running instance carries across a restart', () => {
		expect(
			upgradeBearingFiles([
				'packages/server/src/config/removed-env.ts',
				'packages/server/src/db/client.ts',
				'packages/server/migrations/072_add_column.sql',
				'packages/server/src/cli.ts',
				'packages/server/src/index.ts',
				'packages/server/src/startup.ts',
				'packages/server/src/supervisor.ts',
				'packages/server/src/services/updater.ts',
				'deploy/provision.sh',
				'docker/Dockerfile.agent-base',
			]),
		).toHaveLength(10);
	});

	it('leaves ordinary feature work alone, which ships whole with the binary', () => {
		// A trailer demanded of every commit is a trailer nobody reads.
		expect(
			upgradeBearingFiles([
				'packages/server/src/routes/tasks.ts',
				'packages/server/src/services/agent-runner.ts',
				'packages/web/src/routes/index.tsx',
				'packages/shared/src/types/common.ts',
				'agents/software-development/engineer.md',
				'docs/deployment/configuration.md',
				'packages/server/test/cli.test.ts',
			]),
		).toEqual([]);
	});

	it('matches the named single files exactly, not by prefix', () => {
		const hit = (f: string) => UPGRADE_BEARING_PATTERNS.some((p) => p.test(f));
		expect(hit('packages/server/src/cli.ts')).toBe(true);
		expect(hit('packages/server/src/services/updater.ts')).toBe(true);
		expect(hit('packages/server/test/cli.test.ts')).toBe(false);
		expect(hit('packages/server/test/updater-branches-cov.test.ts')).toBe(false);
	});
});

describe('the Upgrade-Checked trailer', () => {
	const staged = ['packages/server/src/config/schema.ts'];

	it('rejects a config commit with no trailer', () => {
		const r = checkCommitMessage('feat(config): rename the data directory key', staged);
		expect(r.ok).toBe(false);
		expect(r.error).toContain('Upgrade-Checked');
	});

	it('rejects a rubber stamp', () => {
		const r = checkCommitMessage('feat(config): x\n\nUpgrade-Checked: yes', staged);
		expect(r.ok).toBe(false);
		expect(r.error).toContain('not a meaningful acknowledgment');
	});

	it('accepts a real acknowledgment', () => {
		const r = checkCommitMessage(
			'feat(config): x\n\nUpgrade-Checked: the old key is still read and warns; an instance that never rewrites its config is unaffected',
			staged,
		);
		expect(r.ok).toBe(true);
	});

	it('leaves a commit touching nothing upgrade-bearing alone', () => {
		expect(checkCommitMessage('fix: unrelated', ['packages/web/src/main.tsx']).ok).toBe(true);
	});

	it('exempts merges, reverts and fixups', () => {
		for (const msg of ['Merge branch main', 'Revert "x"', 'fixup! earlier']) {
			expect(checkCommitMessage(msg, staged).ok, msg).toBe(true);
		}
	});

	it('reads the trailer case-insensitively, anywhere in the body', () => {
		expect(
			findUpgradeAckValue('title\n\nupgrade-checked: existing instances keep their data'),
		).toBe('existing instances keep their data');
	});
});
