import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	cloneRepo,
	createWorktree,
	ensureTaskWorktree,
	ensureTaskWorktreeWithRetry,
	fastForwardLocalDefault,
	fetchRepo,
	getOriginRemote,
	getRemoteDefaultBranch,
	isTransientMountError,
	localGitLoc,
	mergeDefaultIntoWorktree,
	pruneWorktrees,
	type RepoLoc,
	remoteUrlMatchesRepo,
	setOriginUrl,
	type WorktreeLoc,
} from '../src/services/git';
import {
	type GitExecOpts,
	type GitExecResult,
	type GitExecutor,
	HostGitExecutor,
} from '../src/services/git-executor';
import { hostSandboxFiles } from '../src/services/sandbox/files';

const testDir = join(tmpdir(), `hezo-test-git-${Date.now()}`);
const bareRepoDir = join(testDir, 'bare.git');
const cloneDir = join(testDir, 'clone');

// Production drives git inside the container; tests drive the same orchestration
// against a host git where the host and container paths are the same temp dir.
const exec = new HostGitExecutor();
const repoLoc = (p: string): RepoLoc => localGitLoc(p);
const wtLoc = (p: string): WorktreeLoc => localGitLoc(p);

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
	/** Temp dirs, so host and container paths are the same string. */
	files(containerPath: string) {
		return hostSandboxFiles(containerPath);
	}
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
// default fast-forwarded to the remote. Building/reusing a worktree
// (`ensureTaskWorktree`) never merges trunk in on its own — that catch-up is a
// separate step (`mergeDefaultIntoWorktree`, exercised in its own describe below).
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

	it('reuses a resumed worktree as-is — ensureTaskWorktree alone does not merge trunk', async () => {
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
		// ensureTaskWorktree reuses the existing checkout verbatim; catching it up to
		// advanced trunk is mergeDefaultIntoWorktree's job (tested below).
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

// On a resumed run the runtime catches the task worktree up to the freshly-fetched
// trunk (mergeDefaultIntoWorktree) so the agent starts from current main without
// merging by hand: a fast-forward when the branch is commitless, else a merge
// commit; a dirty tree is skipped and a conflicting merge is aborted, leaving the
// branch where the agent left it.
describe('mergeDefaultIntoWorktree catches a resumed worktree up to trunk', () => {
	const root = join(testDir, 'catch-up');
	const bare = join(root, 'bare.git');
	const repoDir = join(root, 'workspace', 'todos');
	const pusher = join(root, 'pusher');

	function advanceMain(file: string, content: string, message: string) {
		writeFileSync(join(pusher, file), content);
		run('git add .', pusher);
		run(`git commit -m ${message}`, pusher);
		run('git push', pusher);
		run('git fetch --all --prune', repoDir);
	}

	// A worktree on its own task branch, cut from the current trunk tip — what a
	// prior run leaves behind for this run to resume.
	async function resumedWorktree(branch: string): Promise<string> {
		const worktreePath = join(root, 'worktrees', branch.replace('/', '+'), 'todos');
		const res = await ensureTaskWorktree(exec, repoLoc(repoDir), wtLoc(worktreePath), branch);
		expect(res.success).toBe(true);
		return worktreePath;
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

	it('fast-forwards a commitless branch to the advanced trunk', async () => {
		const worktreePath = await resumedWorktree('hezo/CU-1');
		advanceMain('ff.txt', 'fast forward\n', 'advance-ff');
		const remoteTip = sha(repoDir, 'refs/remotes/origin/HEAD');

		const res = await mergeDefaultIntoWorktree(exec, repoLoc(repoDir), wtLoc(worktreePath));
		expect(res.merged).toBe(true);
		expect(res.warning).toBeUndefined();
		expect(sha(worktreePath)).toBe(remoteTip);
		expect(existsSync(join(worktreePath, 'ff.txt'))).toBe(true);
	});

	it('records a merge commit when the branch carries its own commits', async () => {
		const worktreePath = await resumedWorktree('hezo/CU-2');
		writeFileSync(join(worktreePath, 'feature-a.txt'), 'agent A\n');
		run('git add .', worktreePath);
		run('git commit -m feature-a', worktreePath);
		const agentTip = sha(worktreePath);

		advanceMain('feature-b.txt', 'main B\n', 'advance-b');

		const res = await mergeDefaultIntoWorktree(exec, repoLoc(repoDir), wtLoc(worktreePath));
		expect(res.merged).toBe(true);
		// Both the agent's file and the new trunk file land.
		expect(existsSync(join(worktreePath, 'feature-a.txt'))).toBe(true);
		expect(existsSync(join(worktreePath, 'feature-b.txt'))).toBe(true);
		// HEAD is a merge commit (two parents) and the agent's commit is in history.
		const parents = execSync('git rev-list --parents -n1 HEAD', { cwd: worktreePath })
			.toString()
			.trim()
			.split(/\s+/);
		expect(parents).toHaveLength(3);
		expect(parents).toContain(agentTip);
	});

	it('is a no-op when the branch already contains trunk', async () => {
		advanceMain('precreate.txt', 'pre\n', 'advance-pre');
		// Cut off the just-advanced trunk → already current.
		const worktreePath = await resumedWorktree('hezo/CU-3');
		const before = sha(worktreePath);

		const res = await mergeDefaultIntoWorktree(exec, repoLoc(repoDir), wtLoc(worktreePath));
		expect(res.merged).toBe(false);
		expect(res.warning).toBeUndefined();
		expect(sha(worktreePath)).toBe(before);
	});

	it('skips (and warns) when the worktree has uncommitted changes', async () => {
		const worktreePath = await resumedWorktree('hezo/CU-4');
		const before = sha(worktreePath);
		writeFileSync(join(worktreePath, 'dirty.txt'), 'uncommitted\n');

		advanceMain('main-while-dirty.txt', 'main\n', 'advance-dirty');

		const res = await mergeDefaultIntoWorktree(exec, repoLoc(repoDir), wtLoc(worktreePath));
		expect(res.merged).toBe(false);
		expect(res.warning).toMatch(/uncommitted/);
		expect(sha(worktreePath)).toBe(before);
		// The dirty file is untouched and still a pending change.
		expect(existsSync(join(worktreePath, 'dirty.txt'))).toBe(true);
		expect(execSync('git status --porcelain', { cwd: worktreePath }).toString()).toContain(
			'dirty.txt',
		);
	});

	it('aborts a conflicting merge and leaves the branch where the agent left it', async () => {
		const worktreePath = await resumedWorktree('hezo/CU-5');
		// Agent and trunk add the same file divergently → an add/add conflict.
		writeFileSync(join(worktreePath, 'conflict.txt'), 'agent version\n');
		run('git add .', worktreePath);
		run('git commit -m agent-conflict', worktreePath);
		const agentTip = sha(worktreePath);

		advanceMain('conflict.txt', 'main version\n', 'advance-conflict');

		const res = await mergeDefaultIntoWorktree(exec, repoLoc(repoDir), wtLoc(worktreePath));
		expect(res.merged).toBe(false);
		expect(res.warning).toMatch(/could not merge/);
		// Aborted: HEAD back at the agent tip, clean tree, no conflict markers.
		expect(sha(worktreePath)).toBe(agentTip);
		expect(execSync('git status --porcelain', { cwd: worktreePath }).toString().trim()).toBe('');
		expect(readFileSync(join(worktreePath, 'conflict.txt'), 'utf-8')).not.toContain('<<<<<<<');
	});
});

// The first `git worktree add` right after a container reprovision can fail with a
// transient bind-mount ENOENT — the freshly-created worktree parent not yet visible
// in the container's mount namespace. ensureTaskWorktreeWithRetry re-asserts the dir
// (via onRetry) and retries, turning what today surfaces as a whole failed run into
// an in-run retry — while a genuine git failure still fails fast and is never masked.
describe('ensureTaskWorktreeWithRetry retries transient mount ENOENT', () => {
	// Wraps a real HostGitExecutor, failing the first `failFirst` `worktree add`
	// calls with a scripted stderr and delegating everything else to real git.
	class FlakyWorktreeAdd implements GitExecutor {
		/** Temp dirs, so host and container paths are the same string. */
		files(containerPath: string) {
			return hostSandboxFiles(containerPath);
		}
		addCalls = 0;
		constructor(
			private readonly inner: GitExecutor,
			private readonly failFirst: number,
			private readonly stderr: string,
		) {}
		async exec(args: string[], opts: GitExecOpts): Promise<GitExecResult> {
			if (args[0] === 'worktree' && args[1] === 'add') {
				this.addCalls++;
				if (this.addCalls <= this.failFirst) {
					return { exitCode: 128, stdout: '', stderr: this.stderr };
				}
			}
			return this.inner.exec(args, opts);
		}
	}

	const ENOENT_STDERR =
		"fatal: could not open '/worktrees/TO-10/todos/.git' for writing: No such file or directory";

	function freshClone(name: string): { repoDir: string; worktreePath: string } {
		const projectDir = join(testDir, name);
		const repoDir = join(projectDir, 'workspace', 'todos');
		const worktreePath = join(projectDir, 'worktrees', 'TO-10', 'todos');
		mkdirSync(join(projectDir, 'workspace'), { recursive: true });
		run(`git clone ${bareRepoDir} ${repoDir}`);
		configure(repoDir, 'Test');
		return { repoDir, worktreePath };
	}

	it('recovers when the first worktree add fails transiently, then succeeds', async () => {
		const { repoDir, worktreePath } = freshClone('retry-transient');
		const flaky = new FlakyWorktreeAdd(exec, 1, ENOENT_STDERR);
		let retries = 0;
		const res = await ensureTaskWorktreeWithRetry(
			flaky,
			repoLoc(repoDir),
			wtLoc(worktreePath),
			'hezo/TO-10',
			async () => {
				retries++;
			},
			{ retries: 3, delayMs: 0 },
		);
		expect(res.success).toBe(true);
		expect(res.created).toBe(true);
		expect(retries).toBe(1); // one onRetry (re-assert dir) before the successful add
		expect(flaky.addCalls).toBe(2); // failed once, then a real add succeeded
		expect(existsSync(join(worktreePath, '.git'))).toBe(true);
	});

	it('does not retry a genuine (non-transient) failure — fails fast, not masked', async () => {
		const { repoDir, worktreePath } = freshClone('retry-genuine');
		const flaky = new FlakyWorktreeAdd(exec, 99, 'fatal: not a git repository');
		let retries = 0;
		const res = await ensureTaskWorktreeWithRetry(
			flaky,
			repoLoc(repoDir),
			wtLoc(worktreePath),
			'hezo/TO-10',
			async () => {
				retries++;
			},
			{ retries: 3, delayMs: 0 },
		);
		expect(res.success).toBe(false);
		expect(res.error).toContain('not a git repository');
		expect(retries).toBe(0); // predicate rejected it — no retries
		expect(flaky.addCalls).toBe(1); // exactly one attempt, no wasted work
	});

	it('surfaces the original ENOENT after the bounded cap when the mount never settles', async () => {
		const { repoDir, worktreePath } = freshClone('retry-stuck');
		const flaky = new FlakyWorktreeAdd(exec, 99, ENOENT_STDERR);
		let retries = 0;
		const res = await ensureTaskWorktreeWithRetry(
			flaky,
			repoLoc(repoDir),
			wtLoc(worktreePath),
			'hezo/TO-10',
			async () => {
				retries++;
			},
			{ retries: 3, delayMs: 0 },
		);
		expect(res.success).toBe(false);
		expect(res.error).toContain('No such file or directory'); // surfaced, not swallowed
		expect(retries).toBe(2); // retries - 1 onRetry invocations
		expect(flaky.addCalls).toBe(3); // exactly `retries` attempts, bounded
	});
});

// A workspace directory can carry a `.git` that is not a clone of the linked
// repo — an agent's stray `git init` (no origin, unborn HEAD) or an origin
// pointed elsewhere. These primitives let repo-sync detect and heal that state
// instead of every run dying in worktree prep.
describe('origin remote inspection and repair', () => {
	// Neutralize ambient URL rewrites (CI proxies inject `url.*.insteadOf` via
	// GIT_CONFIG_* env and global/system config) so origin URLs read back exactly
	// as stored — like production's clean container git.
	const cleanExec = new HostGitExecutor({
		GIT_CONFIG_COUNT: '0',
		GIT_CONFIG_GLOBAL: '/dev/null',
		GIT_CONFIG_SYSTEM: '/dev/null',
	});

	it('remoteUrlMatchesRepo accepts the URL forms that address the repo', () => {
		const id = 'hezo-ai/website';
		expect(remoteUrlMatchesRepo('git@github.com:hezo-ai/website.git', id)).toBe(true);
		expect(remoteUrlMatchesRepo('git@github.com:hezo-ai/website', id)).toBe(true);
		expect(remoteUrlMatchesRepo('ssh://git@github.com/hezo-ai/website.git', id)).toBe(true);
		expect(remoteUrlMatchesRepo('https://github.com/hezo-ai/website.git', id)).toBe(true);
		expect(remoteUrlMatchesRepo('https://github.com/hezo-ai/website', id)).toBe(true);
		expect(remoteUrlMatchesRepo('https://user@github.com/hezo-ai/website.git', id)).toBe(true);
		expect(remoteUrlMatchesRepo('HTTPS://GitHub.com/Hezo-AI/Website.git', id)).toBe(true);
	});

	it('remoteUrlMatchesRepo rejects other repos and other hosts', () => {
		const id = 'hezo-ai/website';
		expect(remoteUrlMatchesRepo('git@github.com:hezo-ai/hezo.git', id)).toBe(false);
		expect(remoteUrlMatchesRepo('git@github.com:other/website.git', id)).toBe(false);
		expect(remoteUrlMatchesRepo('git@github.com:prefix-hezo-ai/website.git', id)).toBe(false);
		expect(remoteUrlMatchesRepo('git@gitlab.com:hezo-ai/website.git', id)).toBe(false);
		expect(remoteUrlMatchesRepo('https://github.com/hezo-ai/website/extra', id)).toBe(false);
		expect(remoteUrlMatchesRepo('', id)).toBe(false);
	});

	it('getOriginRemote reads a configured origin and repairs via setOriginUrl', async () => {
		const dir = join(testDir, 'origin-inspect');
		mkdirSync(dir, { recursive: true });
		run('git init -b main', dir);
		run('git remote add origin git@github.com:someone/else.git', dir);

		const before = await getOriginRemote(cleanExec, repoLoc(dir));
		expect(before).toEqual({ status: 'configured', url: 'git@github.com:someone/else.git' });

		const fixed = await setOriginUrl(cleanExec, 'git@github.com:owner/right.git', repoLoc(dir));
		expect(fixed.success).toBe(true);
		const after = await getOriginRemote(cleanExec, repoLoc(dir));
		expect(after).toEqual({ status: 'configured', url: 'git@github.com:owner/right.git' });
	});

	it('getOriginRemote reports missing only on a definitive git answer', async () => {
		// A repo with no remotes — git's "No such remote 'origin'".
		const noOrigin = join(testDir, 'origin-none');
		mkdirSync(noOrigin, { recursive: true });
		run('git init -b main', noOrigin);
		expect(await getOriginRemote(cleanExec, repoLoc(noOrigin))).toEqual({ status: 'missing' });

		// A transport-style failure gives no evidence either way.
		const flaky: GitExecutor = {
			files: (containerPath: string) => hostSandboxFiles(containerPath),
			exec: async () => ({ exitCode: 1, stdout: '', stderr: 'docker exec transport died' }),
		};
		expect(await getOriginRemote(flaky, repoLoc(noOrigin))).toEqual({ status: 'indeterminate' });

		// A zero-exit with no URL (a stubbed executor) is indeterminate too.
		const silent: GitExecutor = {
			files: (containerPath: string) => hostSandboxFiles(containerPath),
			exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
		};
		expect(await getOriginRemote(silent, repoLoc(noOrigin))).toEqual({ status: 'indeterminate' });
	});

	it('fetchRepo fails loudly when no origin remote is configured', async () => {
		const dir = join(testDir, 'fetch-no-origin');
		mkdirSync(dir, { recursive: true });
		run('git init -b main', dir);

		const res = await fetchRepo(exec, repoLoc(dir));
		expect(res.success).toBe(false);
		expect(res.error).toBeTruthy();
	});

	it('ensureTaskWorktree fails with an actionable error on an unborn HEAD', async () => {
		// A stray `git init` with no commits and no origin — git itself would die
		// with the opaque "failed to resolve HEAD as a valid ref" (git < 2.42).
		const dir = join(testDir, 'unborn');
		mkdirSync(dir, { recursive: true });
		run('git init -b main', dir);

		const wt = join(testDir, 'worktrees', 'UB-1', 'unborn');
		const res = await ensureTaskWorktree(exec, repoLoc(dir), wtLoc(wt), 'hezo/UB-1');
		expect(res.success).toBe(false);
		expect(res.error).toContain('no commits');
		expect(res.error).toContain('push an initial commit');
		expect(res.error).toContain('the fetch above failed');
	});

	it("fastForwardLocalDefault repairs a clone stuck at git clone's .invalid HEAD sentinel", async () => {
		// The production failure: a `git clone` that dies mid-fetch (a dropped network,
		// the MTU black-hole) leaves .git/HEAD at the `refs/heads/.invalid` sentinel that
		// clone sets before it resolves the real default. Once a later fetch succeeds,
		// origin/<default> exists but HEAD is still the invalid ref — and `git worktree
		// add`, even with an explicit commit-ish, dies with "failed to resolve HEAD as a
		// valid ref" (an unborn *valid* branch would be fine; an invalid ref is not).
		const def = branchOf(cloneDir); // the branch that exists on the bare "remote"
		const initDir = join(testDir, 'invalid-head-clone');
		mkdirSync(initDir, { recursive: true });
		run('git init', initDir);
		configure(initDir, 'Test');
		run(`git remote add origin ${bareRepoDir}`, initDir);
		const fetched = await fetchRepo(exec, repoLoc(initDir));
		expect(fetched.success).toBe(true);
		// Stick HEAD at the sentinel, exactly as an interrupted clone leaves it.
		writeFileSync(join(initDir, '.git', 'HEAD'), 'ref: refs/heads/.invalid\n');
		const before = await exec.exec(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: initDir });
		expect(before.exitCode).not.toBe(0); // HEAD does not resolve

		const warn = await fastForwardLocalDefault(exec, repoLoc(initDir));
		expect(warn).toBeUndefined();

		// HEAD now resolves to the remote default tip.
		const remoteTip = execSync(`git rev-parse refs/remotes/origin/${def}`, { cwd: initDir })
			.toString()
			.trim();
		expect(sha(initDir)).toBe(remoteTip);
		expect(branchOf(initDir)).toBe(def);

		// The worktree add that previously failed with "failed to resolve HEAD" now works.
		const wtDir = join(testDir, 'wt-invalid-head', 'repo');
		const wt = await ensureTaskWorktree(exec, repoLoc(initDir), wtLoc(wtDir), 'hezo/IH-1');
		expect(wt.success).toBe(true);
		expect(existsSync(join(wtDir, 'README.md'))).toBe(true);
	});
});

describe('isTransientMountError', () => {
	it('matches the bind-mount ENOENT signatures', () => {
		expect(
			isTransientMountError(
				"fatal: could not open '/worktrees/TO-1/r/.git' for writing: No such file or directory",
			),
		).toBe(true);
		expect(isTransientMountError('fatal: No such file or directory')).toBe(true);
		expect(isTransientMountError('open /worktrees/x: ENOENT')).toBe(true);
	});

	it('rejects genuine git failures and Hezo markers so they fail fast', () => {
		expect(isTransientMountError('fatal: not a git repository')).toBe(false);
		expect(isTransientMountError('CONFLICT (add/add): Merge conflict in conflict.txt')).toBe(false);
		expect(isTransientMountError('repo is not cloned')).toBe(false);
		expect(isTransientMountError(undefined)).toBe(false);
		expect(isTransientMountError('')).toBe(false);
	});
});
