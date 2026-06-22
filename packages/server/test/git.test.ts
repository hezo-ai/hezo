import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	cloneRepo,
	createWorktree,
	ensureTaskWorktree,
	fastForwardLocalDefault,
	fetchRepo,
	getRemoteDefaultBranch,
	pruneWorktrees,
	type RepoLoc,
	type WorktreeLoc,
} from '../src/services/git';
import {
	type GitExecOpts,
	type GitExecResult,
	type GitExecutor,
	HostGitExecutor,
} from '../src/services/git-executor';

const testDir = join(tmpdir(), `hezo-test-git-${Date.now()}`);
const bareRepoDir = join(testDir, 'bare.git');
const cloneDir = join(testDir, 'clone');

// Production drives git inside the container; tests drive the same orchestration
// against a host git where the host and container paths are the same temp dir.
const exec = new HostGitExecutor();
const repoLoc = (p: string): RepoLoc => ({ hostPath: p, containerPath: p });
const wtLoc = (p: string): WorktreeLoc => ({ hostPath: p, containerPath: p });

function run(cmd: string, cwd?: string) {
	execSync(cmd, { cwd, stdio: 'pipe' });
}
function sha(cwd: string, rev = 'HEAD'): string {
	return execSync(`git rev-parse ${rev}`, { cwd }).toString().trim();
}
function branchOf(cwd: string): string {
	return execSync('git rev-parse --abbrev-ref HEAD', { cwd }).toString().trim();
}
function configure(dir: string, name: string) {
	run(`git config user.name ${name}`, dir);
	run(`git config user.email ${name}@test.com`, dir);
	run('git config commit.gpgsign false', dir);
}

beforeAll(() => {
	mkdirSync(testDir, { recursive: true });
	run(`git init --bare ${bareRepoDir}`);
	run(`git clone ${bareRepoDir} ${cloneDir}`);
	configure(cloneDir, 'Test');
	run('touch README.md', cloneDir);
	run('git add .', cloneDir);
	run('git commit -m init', cloneDir);
	run('git push', cloneDir);
});

afterAll(() => {
	rmSync(testDir, { recursive: true, force: true });
});

// Records every exec so we can assert which git ops need the SSH bridge.
class RecordingExecutor implements GitExecutor {
	calls: Array<{ args: string[]; needsSsh: boolean }> = [];
	async exec(args: string[], opts: GitExecOpts): Promise<GitExecResult> {
		this.calls.push({ args, needsSsh: !!opts.needsSsh });
		return { exitCode: 0, stdout: '', stderr: '' };
	}
}

describe('transport ops request SSH, local ops do not', () => {
	it('marks clone + fetch as needsSsh and worktree add as not', async () => {
		const rec = new RecordingExecutor();
		await cloneRepo(rec, 'owner/repo', repoLoc('/w/repo'));
		await fetchRepo(rec, repoLoc('/w/repo'));
		await createWorktree(rec, repoLoc('/w/repo'), wtLoc('/wt/repo'), 'b');

		const need = (sub: string) => rec.calls.find((c) => c.args[0] === sub)?.needsSsh;
		expect(need('clone')).toBe(true);
		expect(need('fetch')).toBe(true);
		expect(need('worktree')).toBe(false);
	});
});

describe('git worktrees', () => {
	it('creates a worktree', async () => {
		const worktreePath = join(testDir, 'worktrees', 'feat-auth');
		mkdirSync(join(testDir, 'worktrees'), { recursive: true });

		const result = await createWorktree(exec, repoLoc(cloneDir), wtLoc(worktreePath), 'feat/auth');
		expect(result.success).toBe(true);
		expect(existsSync(worktreePath)).toBe(true);
		expect(existsSync(join(worktreePath, 'README.md'))).toBe(true);
	});

	it('prunes stale worktrees without error', async () => {
		await pruneWorktrees(exec, repoLoc(cloneDir));
	});

	it('returns error for duplicate branch', async () => {
		const wt1 = join(testDir, 'worktrees', 'dup1');
		const wt2 = join(testDir, 'worktrees', 'dup2');

		const r1 = await createWorktree(exec, repoLoc(cloneDir), wtLoc(wt1), 'feat/dup');
		expect(r1.success).toBe(true);

		const r2 = await createWorktree(exec, repoLoc(cloneDir), wtLoc(wt2), 'feat/dup');
		expect(r2.success).toBe(false);
		expect(r2.error).toBeTruthy();
	});
});

// A worktree's tree can outlive its admin metadata: the entry under the clone's
// .git/worktrees/<name> is gc'd or the clone is recreated, while the worktree dir
// survives. The leftover .git file then points nowhere and every git command in
// the worktree fails. ensureTaskWorktree must detect this and rebuild from the
// branch, preserving committed work.
describe('rebuilds a worktree orphaned from its clone', () => {
	const projectDir = join(testDir, 'orphan');
	const repoDir = join(projectDir, 'workspace', 'todos');
	const worktreePath = join(projectDir, 'worktrees', 'TO-2', 'todos');

	function adminDir(): string {
		return readFileSync(join(worktreePath, '.git'), 'utf-8').trim().replace('gitdir: ', '');
	}

	beforeAll(() => {
		mkdirSync(join(projectDir, 'workspace'), { recursive: true });
		run(`git clone ${bareRepoDir} ${repoDir}`);
		configure(repoDir, 'Test');
	});

	it('detects the broken link and recreates the worktree, preserving branch commits', async () => {
		const created = await ensureTaskWorktree(
			exec,
			repoLoc(repoDir),
			wtLoc(worktreePath),
			'hezo/TO-2',
		);
		expect(created.success).toBe(true);
		expect(created.created).toBe(true);

		// A local-only commit on the branch — must survive the rebuild.
		writeFileSync(join(worktreePath, 'feature.txt'), 'work in progress\n');
		run('git add .', worktreePath);
		run('git commit -m wip', worktreePath);

		// Orphan the worktree: drop its admin metadata, keep the tree.
		rmSync(adminDir(), { recursive: true, force: true });
		expect(existsSync(join(worktreePath, '.git'))).toBe(true);
		expect(() =>
			execSync('git rev-parse --git-dir', { cwd: worktreePath, stdio: 'pipe' }),
		).toThrow();

		const healed = await ensureTaskWorktree(
			exec,
			repoLoc(repoDir),
			wtLoc(worktreePath),
			'hezo/TO-2',
		);
		expect(healed.success).toBe(true);

		expect(() =>
			execSync('git rev-parse --git-dir', { cwd: worktreePath, stdio: 'pipe' }),
		).not.toThrow();
		expect(existsSync(join(worktreePath, 'feature.txt'))).toBe(true);
		expect(execSync('git log --oneline', { cwd: worktreePath }).toString()).toContain('wip');
	});

	it('reuses a healthy worktree without recreating it', async () => {
		const res = await ensureTaskWorktree(exec, repoLoc(repoDir), wtLoc(worktreePath), 'hezo/TO-2');
		expect(res.success).toBe(true);
		expect(res.created).toBe(false);
		expect(existsSync(join(worktreePath, 'feature.txt'))).toBe(true);
	});
});

// A branch can be checked out in at most one worktree, so a stale checkout left
// behind by a crashed run blocks recreating the task worktree. ensureTaskWorktree
// must free the branch from any such holder first.
describe('frees the task branch from stray worktree holders', () => {
	const projectDir = join(testDir, 'stray');
	const repoDir = join(projectDir, 'workspace', 'todos');

	beforeAll(() => {
		mkdirSync(join(projectDir, 'workspace'), { recursive: true });
		run(`git clone ${bareRepoDir} ${repoDir}`);
		configure(repoDir, 'Test');
	});

	it('removes a stray worktree inside the clone that holds the branch', async () => {
		const branch = 'hezo/TO-9';
		const worktreePath = join(projectDir, 'worktrees', 'TO-9', 'todos');
		const created = await ensureTaskWorktree(exec, repoLoc(repoDir), wtLoc(worktreePath), branch);
		expect(created.success).toBe(true);

		writeFileSync(join(worktreePath, 'feature.txt'), 'work in progress\n');
		run('git add .', worktreePath);
		run('git commit -m wip', worktreePath);

		// The task worktree vanishes (freeing the branch) and a worktree created
		// inside the clone picks the branch up — the state a dead run leaves behind.
		rmSync(worktreePath, { recursive: true, force: true });
		await pruneWorktrees(exec, repoLoc(repoDir));
		run(`git worktree add .claude/worktrees/hezo+TO-9 ${branch}`, repoDir);

		const healed = await ensureTaskWorktree(exec, repoLoc(repoDir), wtLoc(worktreePath), branch);
		expect(healed.success).toBe(true);
		expect(healed.created).toBe(true);

		expect(branchOf(worktreePath)).toBe(branch);
		expect(existsSync(join(worktreePath, 'feature.txt'))).toBe(true);
		const list = execSync('git worktree list --porcelain', { cwd: repoDir }).toString();
		expect(list).not.toContain('.claude/worktrees');
	});

	it('detaches the main clone when it has the task branch checked out', async () => {
		const branch = 'hezo/TO-11';
		run(`git checkout -b ${branch}`, repoDir);

		const worktreePath = join(projectDir, 'worktrees', 'TO-11', 'todos');
		const res = await ensureTaskWorktree(exec, repoLoc(repoDir), wtLoc(worktreePath), branch);
		expect(res.success).toBe(true);
		expect(res.created).toBe(true);

		expect(branchOf(worktreePath)).toBe(branch);
		expect(branchOf(repoDir)).toBe('HEAD');
	});
});

// New task branches start from current trunk; the system keeps the clone's local
// default fast-forwarded to the remote, but never merges trunk into a worktree —
// that reconciliation is the agent's job.
describe('branches off and keeps the default branch current', () => {
	const root = join(testDir, 'default-branch');
	const bare = join(root, 'bare.git');
	const repoDir = join(root, 'workspace', 'todos');
	const pusher = join(root, 'pusher');

	// Advance the remote default from a separate clone, then fetch it into the
	// project clone — what the runner does in-container before building a worktree.
	function advanceMain(file: string, content: string, message: string) {
		writeFileSync(join(pusher, file), content);
		run('git add .', pusher);
		run(`git commit -m ${message}`, pusher);
		run('git push', pusher);
		run('git fetch --all --prune', repoDir);
	}

	beforeAll(() => {
		mkdirSync(join(root, 'workspace'), { recursive: true });
		run(`git init --bare ${bare}`);
		run(`git clone ${bare} ${pusher}`);
		configure(pusher, 'pusher');
		writeFileSync(join(pusher, 'README.md'), 'init\n');
		run('git add .', pusher);
		run('git commit -m init', pusher);
		run('git push', pusher);
		run(`git clone ${bare} ${repoDir}`);
		configure(repoDir, 'agent');
	});

	it('bases a brand-new task branch on the advanced remote default', async () => {
		const staleHead = sha(repoDir);
		advanceMain('mainline.txt', 'advanced on main\n', 'advance-main');
		const advancedTip = sha(repoDir, 'refs/remotes/origin/HEAD');
		expect(advancedTip).not.toBe(staleHead);

		const worktreePath = join(root, 'worktrees', 'DB-1', 'todos');
		const res = await ensureTaskWorktree(exec, repoLoc(repoDir), wtLoc(worktreePath), 'hezo/DB-1');
		expect(res.success).toBe(true);
		expect(res.created).toBe(true);
		expect(sha(worktreePath)).toBe(advancedTip);
		expect(existsSync(join(worktreePath, 'mainline.txt'))).toBe(true);
	});

	it('leaves a resumed worktree untouched when main advances (no auto-merge)', async () => {
		const worktreePath = join(root, 'worktrees', 'DB-2', 'todos');
		const created = await ensureTaskWorktree(
			exec,
			repoLoc(repoDir),
			wtLoc(worktreePath),
			'hezo/DB-2',
		);
		expect(created.success).toBe(true);

		writeFileSync(join(worktreePath, 'agent-work.txt'), 'agent change\n');
		run('git add .', worktreePath);
		run('git commit -m agent-work', worktreePath);
		const agentTip = sha(worktreePath);

		advanceMain('mainline2.txt', 'more main\n', 'advance-again');

		const resumed = await ensureTaskWorktree(
			exec,
			repoLoc(repoDir),
			wtLoc(worktreePath),
			'hezo/DB-2',
		);
		expect(resumed.success).toBe(true);
		expect(resumed.created).toBe(false);
		// The system does NOT merge main in — the worktree is exactly where the agent left it.
		expect(sha(worktreePath)).toBe(agentTip);
		expect(existsSync(join(worktreePath, 'mainline2.txt'))).toBe(false);
	});

	it('fast-forwards the local default ref to origin without touching worktrees', async () => {
		// Detach the clone's HEAD so the default branch is not checked out (the
		// common case at run time) — exercises the update-ref path.
		run('git checkout --detach', repoDir);
		advanceMain('mainline3.txt', 'even more main\n', 'advance-3');

		const def = await getRemoteDefaultBranch(exec, repoLoc(repoDir));
		expect(def).toBeTruthy();
		const remoteTip = sha(repoDir, `refs/remotes/origin/${def}`);

		const warn = await fastForwardLocalDefault(exec, repoLoc(repoDir));
		expect(warn).toBeUndefined();
		expect(sha(repoDir, `refs/heads/${def}`)).toBe(remoteTip);
	});
});
