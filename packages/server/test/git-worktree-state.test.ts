import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	createWorktree,
	getWorktreeHead,
	initRepoInPlace,
	localGitLoc,
	type RepoLoc,
	type WorktreeLoc,
	worktreeHasChanges,
} from '../src/services/git';
import { HostGitExecutor } from '../src/services/git-executor';

const root = mkdtempSync(join(tmpdir(), 'git-wt-state-'));
const exec = new HostGitExecutor();
// Force SSH ops to fail without touching the network (for initRepoInPlace).
const failSshExec = new HostGitExecutor({ GIT_SSH_COMMAND: 'false', GIT_TERMINAL_PROMPT: '0' });
const repoLoc = (p: string): RepoLoc => localGitLoc(p);
const wtLoc = (p: string): WorktreeLoc => localGitLoc(p);

function run(cmd: string, cwd?: string) {
	execSync(cmd, { cwd, stdio: 'pipe' });
}

let cloneDir: string;
let worktreeDir: string;

beforeAll(() => {
	const bare = join(root, 'bare.git');
	cloneDir = join(root, 'clone');
	worktreeDir = join(root, 'wt');
	run(`git init --bare ${bare}`);
	run(`git clone ${bare} ${cloneDir}`);
	run('git config user.name Test', cloneDir);
	run('git config user.email test@test.com', cloneDir);
	run('git config commit.gpgsign false', cloneDir);
	writeFileSync(join(cloneDir, 'README.md'), '# hi');
	run('git add .', cloneDir);
	run('git commit -m init', cloneDir);
	run('git push', cloneDir);
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe('getWorktreeHead', () => {
	it('returns null for a path with no .git', async () => {
		const head = await getWorktreeHead(exec, wtLoc(join(root, 'nope')));
		expect(head).toBeNull();
	});

	it('returns the current commit sha for a real worktree', async () => {
		const created = await createWorktree(exec, repoLoc(cloneDir), wtLoc(worktreeDir), 'feat/state');
		expect(created.success).toBe(true);
		const head = await getWorktreeHead(exec, wtLoc(worktreeDir));
		expect(head).toMatch(/^[0-9a-f]{40}$/);
		// Matches what git reports directly.
		const direct = execSync('git rev-parse HEAD', { cwd: worktreeDir }).toString().trim();
		expect(head).toBe(direct);
	});
});

describe('worktreeHasChanges', () => {
	it('returns false for a missing worktree', async () => {
		expect(await worktreeHasChanges(exec, wtLoc(join(root, 'gone')), null)).toBe(false);
	});

	it('returns false for a clean, unchanged worktree', async () => {
		const head = await getWorktreeHead(exec, wtLoc(worktreeDir));
		expect(await worktreeHasChanges(exec, wtLoc(worktreeDir), head)).toBe(false);
	});

	it('detects an uncommitted/untracked change', async () => {
		const head = await getWorktreeHead(exec, wtLoc(worktreeDir));
		writeFileSync(join(worktreeDir, 'new-file.txt'), 'dirty');
		expect(await worktreeHasChanges(exec, wtLoc(worktreeDir), head)).toBe(true);
	});

	it('detects an advanced branch tip (commit since headBefore)', async () => {
		const headBefore = await getWorktreeHead(exec, wtLoc(worktreeDir));
		// Commit the untracked file so the tree is clean but the tip advanced.
		run('git add .', worktreeDir);
		run('git config user.name Test', worktreeDir);
		run('git config user.email test@test.com', worktreeDir);
		run('git config commit.gpgsign false', worktreeDir);
		run('git commit -m advance', worktreeDir);
		expect(await worktreeHasChanges(exec, wtLoc(worktreeDir), headBefore)).toBe(true);
	});
});

describe('initRepoInPlace (SSH transport)', () => {
	it('returns { success: false, error } when the SSH remote is unreachable', async () => {
		// A populated directory connected to an SSH remote that cannot be reached:
		// init + remote add succeed, the ls-remote over SSH fails → graceful failure.
		const dir = join(root, 'in-place');
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'app.ts'), 'export const x = 1;');
		const result = await initRepoInPlace(
			failSshExec,
			'nonexistent-org-hezo/nonexistent-repo',
			repoLoc(dir),
		);
		expect(result.success).toBe(false);
		expect(typeof result.error).toBe('string');
		expect(result.error).toBeTruthy();
	});
});
