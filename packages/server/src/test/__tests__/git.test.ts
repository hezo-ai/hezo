import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorktree, pruneWorktrees, removeWorktree } from '../../services/git';

const testDir = join(tmpdir(), `hezo-test-git-${Date.now()}`);
const bareRepoDir = join(testDir, 'bare.git');
const cloneDir = join(testDir, 'clone');

function run(cmd: string, cwd?: string) {
	execSync(cmd, { cwd, stdio: 'pipe' });
}

beforeAll(() => {
	mkdirSync(testDir, { recursive: true });
	run(`git init --bare ${bareRepoDir}`);
	run(`git clone ${bareRepoDir} ${cloneDir}`);
	run('git config user.name Test', cloneDir);
	run('git config user.email test@test.com', cloneDir);
	run('git config commit.gpgsign false', cloneDir);
	run('touch README.md', cloneDir);
	run('git add .', cloneDir);
	run('git commit -m init', cloneDir);
	run('git push', cloneDir);
});

afterAll(() => {
	rmSync(testDir, { recursive: true, force: true });
});

describe('git worktrees', () => {
	it('creates a worktree', async () => {
		const worktreePath = join(testDir, 'worktrees', 'feat-auth');
		mkdirSync(join(testDir, 'worktrees'), { recursive: true });

		const result = await createWorktree(cloneDir, worktreePath, 'feat/auth');
		expect(result.success).toBe(true);
		expect(existsSync(worktreePath)).toBe(true);
		expect(existsSync(join(worktreePath, 'README.md'))).toBe(true);
	});

	it('removes a worktree', async () => {
		const worktreePath = join(testDir, 'worktrees', 'feat-remove');
		const createResult = await createWorktree(cloneDir, worktreePath, 'feat/remove');
		expect(createResult.success).toBe(true);

		const removeResult = await removeWorktree(cloneDir, worktreePath);
		expect(removeResult.success).toBe(true);
		expect(existsSync(worktreePath)).toBe(false);
	});

	it('prunes stale worktrees without error', async () => {
		await pruneWorktrees(cloneDir);
	});

	it('returns error for duplicate branch', async () => {
		const wt1 = join(testDir, 'worktrees', 'dup1');
		const wt2 = join(testDir, 'worktrees', 'dup2');

		const r1 = await createWorktree(cloneDir, wt1, 'feat/dup');
		expect(r1.success).toBe(true);

		const r2 = await createWorktree(cloneDir, wt2, 'feat/dup');
		expect(r2.success).toBe(false);
		expect(r2.error).toBeTruthy();
	});
});
