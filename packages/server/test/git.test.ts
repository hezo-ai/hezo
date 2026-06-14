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

// A worktree's tree can outlive its admin metadata: the entry under the clone's
// .git/worktrees/<name> gets pruned/gc'd (e.g. an old absolute link no longer
// resolved inside the container) or the clone is recreated, while the worktree
// dir survives on its separate mount. The leftover .git file then points nowhere
// and every git command in the worktree fails with "not a git repository".
// ensureTaskWorktree must detect this and rebuild the worktree from the branch.
describe('rebuilds a worktree orphaned from its clone', () => {
	const projectDir = join(testDir, 'orphan');
	const repoDir = join(projectDir, 'workspace', 'todos');
	const worktreePath = join(projectDir, 'worktrees', 'TO-2', 'todos');

	function adminDir(): string {
		const rel = readFileSync(join(worktreePath, '.git'), 'utf-8').trim().replace('gitdir: ', '');
		return join(worktreePath, rel);
	}

	beforeAll(() => {
		mkdirSync(join(projectDir, 'workspace'), { recursive: true });
		run(`git clone ${bareRepoDir} ${repoDir}`);
		run('git config user.name Test', repoDir);
		run('git config user.email test@test.com', repoDir);
		run('git config commit.gpgsign false', repoDir);
	});

	it('detects the broken link and recreates the worktree, preserving branch commits', async () => {
		const created = await ensureTaskWorktree(repoDir, worktreePath, 'hezo/TO-2');
		expect(created.success).toBe(true);
		expect(created.created).toBe(true);

		// A local-only commit on the branch — must survive the rebuild.
		run('git config user.name Test', worktreePath);
		run('git config user.email test@test.com', worktreePath);
		run('git config commit.gpgsign false', worktreePath);
		writeFileSync(join(worktreePath, 'feature.txt'), 'work in progress\n');
		run('git add .', worktreePath);
		run('git commit -m wip', worktreePath);

		// Orphan the worktree: drop its admin metadata, keep the tree.
		rmSync(adminDir(), { recursive: true, force: true });
		expect(existsSync(join(worktreePath, '.git'))).toBe(true);
		expect(() =>
			execSync('git rev-parse --git-dir', { cwd: worktreePath, stdio: 'pipe' }),
		).toThrow();

		const healed = await ensureTaskWorktree(repoDir, worktreePath, 'hezo/TO-2');
		expect(healed.success).toBe(true);

		// Worktree resolves again and the local-only commit is intact.
		expect(() =>
			execSync('git rev-parse --git-dir', { cwd: worktreePath, stdio: 'pipe' }),
		).not.toThrow();
		expect(existsSync(join(worktreePath, 'feature.txt'))).toBe(true);
		const log = execSync('git log --oneline', { cwd: worktreePath }).toString();
		expect(log).toContain('wip');

		// And the rebuilt link is still container-portable (relative).
		const dotGit = readFileSync(join(worktreePath, '.git'), 'utf-8').trim();
		expect(dotGit.startsWith('gitdir: ../')).toBe(true);
		expect(dotGit).not.toMatch(/gitdir: \//);
	});
});

// A branch can be checked out in at most one worktree, so a stale checkout left
// behind by a crashed run — e.g. a worktree the agent created inside the clone
// itself (.claude/worktrees/...), possibly registered under container-absolute
// paths that resolve nowhere on the host — blocks recreating the task worktree.
// ensureTaskWorktree must free the branch from any such holder first.
describe('frees the task branch from stray worktree holders', () => {
	const projectDir = join(testDir, 'stray');
	const repoDir = join(projectDir, 'workspace', 'todos');

	function worktreeHead(cwd: string): string {
		return execSync('git rev-parse --abbrev-ref HEAD', { cwd }).toString().trim();
	}

	beforeAll(() => {
		mkdirSync(join(projectDir, 'workspace'), { recursive: true });
		run(`git clone ${bareRepoDir} ${repoDir}`);
		run('git config user.name Test', repoDir);
		run('git config user.email test@test.com', repoDir);
		run('git config commit.gpgsign false', repoDir);
	});

	it('removes a stray worktree inside the clone that holds the branch', async () => {
		const branch = 'hezo/TO-9';
		const worktreePath = join(projectDir, 'worktrees', 'TO-9', 'todos');
		const created = await ensureTaskWorktree(repoDir, worktreePath, branch);
		expect(created.success).toBe(true);

		// A local-only commit on the branch — must survive the healing.
		writeFileSync(join(worktreePath, 'feature.txt'), 'work in progress\n');
		run('git add .', worktreePath);
		run('git commit -m wip', worktreePath);

		// The task worktree vanishes (freeing the branch) and a worktree created
		// inside the clone picks the branch up — the state a dead run leaves behind.
		rmSync(worktreePath, { recursive: true, force: true });
		await pruneWorktrees(repoDir);
		run(`git worktree add .claude/worktrees/hezo+TO-9 ${branch}`, repoDir);

		const healed = await ensureTaskWorktree(repoDir, worktreePath, branch);
		expect(healed.success).toBe(true);
		expect(healed.created).toBe(true);

		expect(worktreeHead(worktreePath)).toBe(branch);
		expect(existsSync(join(worktreePath, 'feature.txt'))).toBe(true);
		const list = execSync('git worktree list --porcelain', { cwd: repoDir }).toString();
		expect(list).not.toContain('.claude/worktrees');
	});

	it('prunes a holder registered under a path that does not resolve on the host', async () => {
		const branch = 'hezo/TO-10';
		const worktreePath = join(projectDir, 'worktrees', 'TO-10', 'todos');
		const created = await ensureTaskWorktree(repoDir, worktreePath, branch);
		expect(created.success).toBe(true);

		rmSync(worktreePath, { recursive: true, force: true });
		await pruneWorktrees(repoDir);
		run(`git worktree add .claude/worktrees/hezo+TO-10 ${branch}`, repoDir);

		// Rewrite the registration to the container-absolute path it would carry
		// in production and drop the tree, so nothing resolves host-side.
		writeFileSync(
			join(repoDir, '.git', 'worktrees', 'hezo+TO-10', 'gitdir'),
			'/workspace/todos/.claude/worktrees/hezo+TO-10/.git\n',
		);
		rmSync(join(repoDir, '.claude'), { recursive: true, force: true });

		const healed = await ensureTaskWorktree(repoDir, worktreePath, branch);
		expect(healed.success).toBe(true);
		expect(worktreeHead(worktreePath)).toBe(branch);
	});

	it('detaches the main clone when it has the task branch checked out', async () => {
		const branch = 'hezo/TO-11';
		run(`git checkout -b ${branch}`, repoDir);

		const worktreePath = join(projectDir, 'worktrees', 'TO-11', 'todos');
		const res = await ensureTaskWorktree(repoDir, worktreePath, branch);
		expect(res.success).toBe(true);
		expect(res.created).toBe(true);

		expect(worktreeHead(worktreePath)).toBe(branch);
		expect(worktreeHead(repoDir)).toBe('HEAD');
	});
});
