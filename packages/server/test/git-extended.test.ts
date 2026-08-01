import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cloneRepo, localGitLoc } from '../src/services/git';
import { HostGitExecutor } from '../src/services/git-executor';

const testDir = mkdtempSync(join(tmpdir(), 'hezo-test-git-extended-'));

// Force the SSH transport to fail immediately so the clone fails without touching
// the network — mirrors an unreachable ssh-agent / bridge in production.
const exec = new HostGitExecutor({ GIT_SSH_COMMAND: 'false', GIT_TERMINAL_PROMPT: '0' });
const loc = (p: string) => localGitLoc(p);
const MISSING = 'nonexistent-org-hezo-test/nonexistent-repo-xyz';

afterAll(() => {
	rmSync(testDir, { recursive: true, force: true });
});

describe('cloneRepo', { timeout: 30_000 }, () => {
	it('returns { success: false, error } when the transport is unreachable', async () => {
		const result = await cloneRepo(exec, MISSING, loc(join(testDir, 'clone-fail')));

		expect(result.success).toBe(false);
		expect(typeof result.error).toBe('string');
		expect(result.error).toBeTruthy();
	});

	it('does not throw on clone failure', async () => {
		await expect(
			cloneRepo(exec, MISSING, loc(join(testDir, 'clone-no-throw'))),
		).resolves.not.toThrow();
	});

	it('does not leave a usable clone on failure', async () => {
		const targetDir = join(testDir, 'clone-no-dir');
		const result = await cloneRepo(exec, MISSING, loc(targetDir));

		expect(result.success).toBe(false);
		expect(existsSync(join(targetDir, '.git'))).toBe(false);
	});
});
