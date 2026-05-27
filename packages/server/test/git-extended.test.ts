import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cloneRepo, ensureGithubKnownHosts } from '../src/services/git';

const testDir = mkdtempSync(join(tmpdir(), 'hezo-test-git-extended-'));

afterAll(() => {
	rmSync(testDir, { recursive: true, force: true });
});

describe('cloneRepo', { timeout: 30_000 }, () => {
	it('returns { success: false, error } when ssh-agent is unreachable', async () => {
		const knownHostsPath = await ensureGithubKnownHosts(testDir);
		const targetDir = join(testDir, 'clone-fail');
		const result = await cloneRepo(
			'nonexistent-org-hezo-test/nonexistent-repo-xyz',
			targetDir,
			'/nonexistent-ssh-agent-socket',
			knownHostsPath,
		);

		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
		expect(typeof result.error).toBe('string');
	});

	it('does not throw on clone failure', async () => {
		const knownHostsPath = await ensureGithubKnownHosts(testDir);
		const targetDir = join(testDir, 'clone-no-throw');
		await expect(
			cloneRepo(
				'nonexistent-org-hezo-test/nonexistent-repo-xyz',
				targetDir,
				'/nonexistent-ssh-agent-socket',
				knownHostsPath,
			),
		).resolves.not.toThrow();
	});

	it('does not create the target directory on failure', async () => {
		const knownHostsPath = await ensureGithubKnownHosts(testDir);
		const targetDir = join(testDir, 'clone-no-dir');
		const result = await cloneRepo(
			'nonexistent-org-hezo-test/nonexistent-repo-xyz',
			targetDir,
			'/nonexistent-ssh-agent-socket',
			knownHostsPath,
		);

		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
	});
});
