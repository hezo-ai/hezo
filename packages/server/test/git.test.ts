import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	createWorktree,
	ensureTaskWorktree,
	pruneWorktrees,
	removeWorktree,
} from '../src/services/git';

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

// A worktree is created on the host but used inside the container, where the same
// repo lives at a different absolute path under separate bind mounts. The gitdir
// links must therefore be relative — an absolute host path resolves nowhere in the
// container. Mirror the on-disk layout so the relative link is exercised exactly as
// it would be at runtime: workspace/<repo> and worktrees/<task>/<repo> as siblings.
describe('worktree gitdir links are container-portable (relative)', () => {
	const projectDir = join(testDir, 'proj');
	const repoDir = join(projectDir, 'workspace', 'todos');
	const worktreePath = join(projectDir, 'worktrees', 'TO-1', 'todos');

	function adminDirName(): string {
		return readFileSync(join(worktreePath, '.git'), 'utf-8').trim().split('/').pop() as string;
	}

	beforeAll(() => {
		mkdirSync(join(projectDir, 'workspace'), { recursive: true });
		run(`git clone ${bareRepoDir} ${repoDir}`);
		run('git config user.name Test', repoDir);
		run('git config user.email test@test.com', repoDir);
		run('git config commit.gpgsign false', repoDir);
	});

	it('writes relative gitdir pointers on create', async () => {
		const res = await ensureTaskWorktree(repoDir, worktreePath, 'hezo/TO-1');
		expect(res.success).toBe(true);
		expect(res.created).toBe(true);

		const dotGit = readFileSync(join(worktreePath, '.git'), 'utf-8').trim();
		expect(dotGit.startsWith('gitdir: ../')).toBe(true);
		expect(dotGit).not.toMatch(/gitdir: \//);

		const backPtr = readFileSync(
			join(repoDir, '.git', 'worktrees', adminDirName(), 'gitdir'),
			'utf-8',
		).trim();
		expect(backPtr.startsWith('../')).toBe(true);
		expect(backPtr.startsWith('/')).toBe(false);
	});

	it('self-heals an absolute gitdir back to relative on reuse', async () => {
		const absoluteTarget = join(repoDir, '.git', 'worktrees', adminDirName());
		writeFileSync(join(worktreePath, '.git'), `gitdir: ${absoluteTarget}\n`);
		expect(readFileSync(join(worktreePath, '.git'), 'utf-8')).toMatch(/gitdir: \//);

		const res = await ensureTaskWorktree(repoDir, worktreePath, 'hezo/TO-1');
		expect(res.success).toBe(true);
		expect(res.created).toBe(false);

		const dotGit = readFileSync(join(worktreePath, '.git'), 'utf-8').trim();
		expect(dotGit.startsWith('gitdir: ../')).toBe(true);
		expect(dotGit).not.toMatch(/gitdir: \//);
	});
});
