import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RepoHostType } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	buildGitSshUrl,
	connectExistingRepo,
	createWorktree,
	ensureTaskWorktree,
	fastForwardLocalDefault,
	getRemoteDefaultBranch,
	localGitLoc,
	mergeDefaultIntoWorktree,
	type RepoLoc,
	type WorktreeLoc,
} from '../src/services/git';
import type { GitExecOpts, GitExecResult, GitExecutor } from '../src/services/git-executor';
import { HostGitExecutor } from '../src/services/git-executor';
import { hostSandboxFiles } from '../src/services/sandbox/files';

const root = mkdtempSync(join(tmpdir(), 'git-coverage-'));
const exec = new HostGitExecutor();
const repoLoc = (p: string): RepoLoc => localGitLoc(p);
const wtLoc = (p: string): WorktreeLoc => localGitLoc(p);

function run(cmd: string, cwd?: string) {
	execSync(cmd, { cwd, stdio: 'pipe' });
}
function sha(cwd: string, rev = 'HEAD'): string {
	return execSync(`git rev-parse ${rev}`, { cwd }).toString().trim();
}
function configure(dir: string, name: string) {
	run(`git config user.name ${name}`, dir);
	run(`git config user.email ${name}@test.com`, dir);
	run('git config commit.gpgsign false', dir);
}

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

// A scripted executor: matches each call to a predicate and returns a canned
// result. Lets us drive the exact exit-code branches (init fail, remote-add
// fail, an unresolvable rev=128, etc.) deterministically without contriving a
// real git repo for each.
type Rule = {
	match: (args: string[]) => boolean;
	result: GitExecResult;
};
class ScriptedExecutor implements GitExecutor {
	/** Temp dirs, so host and container paths are the same string. */
	files(containerPath: string) {
		return hostSandboxFiles(containerPath);
	}
	calls: string[][] = [];
	constructor(private rules: Rule[]) {}
	async exec(args: string[], _opts: GitExecOpts): Promise<GitExecResult> {
		this.calls.push(args);
		for (const r of this.rules) {
			if (r.match(args)) return r.result;
		}
		return { exitCode: 0, stdout: '', stderr: '' };
	}
}
const ok = (stdout = ''): GitExecResult => ({ exitCode: 0, stdout, stderr: '' });
const fail = (stderr = 'boom', exitCode = 1): GitExecResult => ({ exitCode, stdout: '', stderr });

describe('buildGitSshUrl', () => {
	it('builds a github SSH url', () => {
		expect(buildGitSshUrl(RepoHostType.GitHub, 'acme/widgets')).toBe(
			'git@github.com:acme/widgets.git',
		);
	});

	it('throws on an unsupported host type', () => {
		expect(() => buildGitSshUrl('gitlab' as RepoHostType, 'acme/widgets')).toThrow(
			/Unsupported repo host type/,
		);
	});
});

describe('getRemoteDefaultBranch', () => {
	it('returns null when no candidate branch ref exists (empty/unborn remote)', async () => {
		const bare = join(root, 'empty-default.git');
		const clone = join(root, 'empty-default-clone');
		run(`git init --bare -b main ${bare}`);
		run(`git clone ${bare} ${clone}`);
		// Fresh clone of an empty remote: no origin/HEAD symref and neither
		// origin/main nor origin/master exists yet.
		const def = await getRemoteDefaultBranch(exec, repoLoc(clone));
		expect(def).toBeNull();
	});

	it('falls back to origin/main when origin/HEAD symref is absent', async () => {
		const bare = join(root, 'mainfallback.git');
		const pusher = join(root, 'mainfallback-pusher');
		const clone = join(root, 'mainfallback-clone');
		run(`git init --bare -b main ${bare}`);
		run(`git clone ${bare} ${pusher}`);
		configure(pusher, 'pusher');
		writeFileSync(join(pusher, 'README.md'), 'hi\n');
		run('git add .', pusher);
		run('git commit -m init', pusher);
		run('git push', pusher);
		run(`git clone ${bare} ${clone}`);
		// Remove origin/HEAD so resolution must fall through to the main/master probe.
		run('git remote set-head origin --delete', clone);
		const def = await getRemoteDefaultBranch(exec, repoLoc(clone));
		expect(def).toBe('main');
	});
});

describe('fastForwardLocalDefault', () => {
	it('returns undefined (no-op) when no default branch resolves', async () => {
		const bare = join(root, 'ff-empty.git');
		const clone = join(root, 'ff-empty-clone');
		run(`git init --bare -b main ${bare}`);
		run(`git clone ${bare} ${clone}`);
		const warn = await fastForwardLocalDefault(exec, repoLoc(clone));
		expect(warn).toBeUndefined();
	});

	it('fast-forwards via merge when the default branch is checked out', async () => {
		const bare = join(root, 'ff-checked.git');
		const pusher = join(root, 'ff-checked-pusher');
		const clone = join(root, 'ff-checked-clone');
		run(`git init --bare -b main ${bare}`);
		run(`git clone ${bare} ${pusher}`);
		configure(pusher, 'pusher');
		writeFileSync(join(pusher, 'README.md'), 'init\n');
		run('git add .', pusher);
		run('git commit -m init', pusher);
		run('git push', pusher);
		run(`git clone ${bare} ${clone}`);
		configure(clone, 'agent');
		// Advance trunk from the pusher and fetch into the clone, which still has
		// `main` checked out → the merge --ff-only branch.
		writeFileSync(join(pusher, 'next.txt'), 'more\n');
		run('git add .', pusher);
		run('git commit -m advance', pusher);
		run('git push', pusher);
		run('git fetch --all --prune', clone);
		const remoteTip = sha(clone, 'refs/remotes/origin/main');

		const warn = await fastForwardLocalDefault(exec, repoLoc(clone));
		expect(warn).toBeUndefined();
		expect(sha(clone, 'refs/heads/main')).toBe(remoteTip);
		// Working tree advanced too (it was checked out).
		expect(existsSync(join(clone, 'next.txt'))).toBe(true);
	});

	it('warns and does not rewind when the local default has diverged from origin', async () => {
		const bare = join(root, 'ff-diverge.git');
		const pusher = join(root, 'ff-diverge-pusher');
		const clone = join(root, 'ff-diverge-clone');
		run(`git init --bare -b main ${bare}`);
		run(`git clone ${bare} ${pusher}`);
		configure(pusher, 'pusher');
		writeFileSync(join(pusher, 'README.md'), 'init\n');
		run('git add .', pusher);
		run('git commit -m init', pusher);
		run('git push', pusher);
		run(`git clone ${bare} ${clone}`);
		configure(clone, 'agent');
		// Give the clone a local commit on main that origin doesn't have, then
		// detach HEAD so main is not checked out → the update-ref path with the
		// is-ancestor guard tripping (local is NOT an ancestor of origin).
		writeFileSync(join(clone, 'local-only.txt'), 'divergent\n');
		run('git add .', clone);
		run('git commit -m local-divergence', clone);
		const localTip = sha(clone, 'refs/heads/main');
		// Advance origin independently.
		writeFileSync(join(pusher, 'main-side.txt'), 'origin\n');
		run('git add .', pusher);
		run('git commit -m origin-advance', pusher);
		run('git push', pusher);
		run('git fetch --all --prune', clone);
		run('git checkout --detach', clone);

		const warn = await fastForwardLocalDefault(exec, repoLoc(clone));
		expect(warn).toMatch(/diverged/);
		// Ref untouched: still at the local divergent tip.
		expect(sha(clone, 'refs/heads/main')).toBe(localTip);
	});

	it('surfaces a warning when the merge --ff-only itself fails', async () => {
		// Scripted: default resolves to main, HEAD is main, but the ff merge fails.
		const scripted = new ScriptedExecutor([
			{
				match: (a) => a[0] === 'symbolic-ref' && a.includes('refs/remotes/origin/HEAD'),
				result: ok('origin/main\n'),
			},
			{
				match: (a) => a[0] === 'rev-parse' && a.includes('refs/remotes/origin/main'),
				result: ok(),
			},
			{ match: (a) => a[0] === 'symbolic-ref' && a.includes('HEAD'), result: ok('main\n') },
			{ match: (a) => a[0] === 'merge', result: fail('not possible to fast-forward') },
		]);
		const warn = await fastForwardLocalDefault(scripted, repoLoc('/x'));
		expect(warn).toMatch(/could not fast-forward main/);
	});
});

describe('mergeDefaultIntoWorktree (scripted error branches)', () => {
	it('warns when the ancestor comparison is unresolvable (exit !=0,1)', async () => {
		const scripted = new ScriptedExecutor([
			{
				match: (a) => a[0] === 'symbolic-ref' && a.includes('refs/remotes/origin/HEAD'),
				result: ok('origin/main\n'),
			},
			{
				match: (a) => a[0] === 'rev-parse' && a.includes('refs/remotes/origin/main'),
				result: ok(),
			},
			// merge-base --is-ancestor returns 128 (e.g. unknown rev) → skip + warn.
			{
				match: (a) => a[0] === 'merge-base' && a.includes('--is-ancestor'),
				result: fail('fatal: bad rev', 128),
			},
		]);
		const res = await mergeDefaultIntoWorktree(scripted, repoLoc('/r'), wtLoc('/wt'));
		expect(res.merged).toBe(false);
		expect(res.warning).toMatch(/could not compare with origin\/main/);
	});

	it('returns not-merged with no warning when no default branch resolves', async () => {
		const scripted = new ScriptedExecutor([
			{ match: (a) => a[0] === 'symbolic-ref', result: fail('no symref') },
			{ match: (a) => a[0] === 'rev-parse', result: fail('no ref') },
		]);
		const res = await mergeDefaultIntoWorktree(scripted, repoLoc('/r'), wtLoc('/wt'));
		expect(res.merged).toBe(false);
		expect(res.warning).toBeUndefined();
	});
});

describe('addTaskWorktree branch-source selection', () => {
	let cloneDir: string;
	let pusher: string;

	beforeAll(() => {
		const bare = join(root, 'addwt.git');
		pusher = join(root, 'addwt-pusher');
		cloneDir = join(root, 'addwt-clone');
		run(`git init --bare -b main ${bare}`);
		run(`git clone ${bare} ${pusher}`);
		configure(pusher, 'pusher');
		writeFileSync(join(pusher, 'README.md'), 'init\n');
		run('git add .', pusher);
		run('git commit -m init', pusher);
		run('git push', pusher);
		run(`git clone ${bare} ${cloneDir}`);
		configure(cloneDir, 'agent');
	});

	it('checks out an existing LOCAL branch as-is, preserving its commits', async () => {
		// Create a local-only branch with a unique commit, leaving main checked out.
		run('git branch feat/local main', cloneDir);
		run('git checkout feat/local', cloneDir);
		writeFileSync(join(cloneDir, 'local-feature.txt'), 'local work\n');
		run('git add .', cloneDir);
		run('git commit -m local-feature', cloneDir);
		const localTip = sha(cloneDir, 'refs/heads/feat/local');
		run('git checkout main', cloneDir);

		const wt = join(root, 'addwt-wt-local');
		const res = await ensureTaskWorktree(exec, repoLoc(cloneDir), wtLoc(wt), 'feat/local');
		expect(res.success).toBe(true);
		expect(res.created).toBe(true);
		// The existing local branch was used directly — its commit is present.
		expect(sha(wt)).toBe(localTip);
		expect(existsSync(join(wt, 'local-feature.txt'))).toBe(true);
	});

	it('tracks an existing REMOTE branch when no local branch exists', async () => {
		// Push a branch from the pusher so it exists only as origin/<branch> in the
		// clone after a fetch — no local ref.
		run('git checkout -b feat/remote main', pusher);
		writeFileSync(join(pusher, 'remote-feature.txt'), 'remote work\n');
		run('git add .', pusher);
		run('git commit -m remote-feature', pusher);
		run('git push -u origin feat/remote', pusher);
		run('git fetch --all --prune', cloneDir);
		const remoteTip = sha(cloneDir, 'refs/remotes/origin/feat/remote');

		const wt = join(root, 'addwt-wt-remote');
		const res = await ensureTaskWorktree(exec, repoLoc(cloneDir), wtLoc(wt), 'feat/remote');
		expect(res.success).toBe(true);
		expect(res.created).toBe(true);
		// Tracked the remote branch: the worktree starts at the remote tip and the
		// remote-only file is present.
		expect(sha(wt)).toBe(remoteTip);
		expect(existsSync(join(wt, 'remote-feature.txt'))).toBe(true);
	});

	it('returns an error from createWorktree when the branch is already checked out elsewhere', async () => {
		const wt1 = join(root, 'addwt-dup1');
		const wt2 = join(root, 'addwt-dup2');
		const r1 = await createWorktree(exec, repoLoc(cloneDir), wtLoc(wt1), 'feat/dup-cov');
		expect(r1.success).toBe(true);
		const r2 = await createWorktree(exec, repoLoc(cloneDir), wtLoc(wt2), 'feat/dup-cov');
		expect(r2.success).toBe(false);
		expect(r2.error).toBeTruthy();
	});
});

describe('connectExistingRepo scripted failure branches', () => {
	it('rolls back and fails when git init fails (no pre-existing .git)', async () => {
		const dir = join(root, 'cer-init-fail');
		mkdirSync(dir, { recursive: true });
		const scripted = new ScriptedExecutor([
			{ match: (a) => a[0] === 'init', result: fail('init exploded') },
		]);
		const res = await connectExistingRepo(scripted, 'file:///x', repoLoc(dir), false);
		expect(res.success).toBe(false);
		expect(res.error).toBe('init exploded');
	});

	it('fails when remote add fails', async () => {
		const dir = join(root, 'cer-remote-fail');
		mkdirSync(dir, { recursive: true });
		const scripted = new ScriptedExecutor([
			{ match: (a) => a[0] === 'init', result: ok() },
			{ match: (a) => a[0] === 'remote', result: fail('remote add failed') },
		]);
		const res = await connectExistingRepo(scripted, 'file:///x', repoLoc(dir), false);
		expect(res.success).toBe(false);
		expect(res.error).toBe('remote add failed');
	});

	it('fails when ls-remote fails', async () => {
		const dir = join(root, 'cer-lsremote-fail');
		mkdirSync(dir, { recursive: true });
		const scripted = new ScriptedExecutor([
			{ match: (a) => a[0] === 'init', result: ok() },
			{ match: (a) => a[0] === 'remote', result: ok() },
			{ match: (a) => a[0] === 'ls-remote', result: fail('cannot reach remote') },
		]);
		const res = await connectExistingRepo(scripted, 'file:///x', repoLoc(dir), true);
		expect(res.success).toBe(false);
		expect(res.error).toBe('cannot reach remote');
	});

	it('fails when the remote has refs but the default branch cannot be determined', async () => {
		const dir = join(root, 'cer-nobranch');
		mkdirSync(dir, { recursive: true });
		const scripted = new ScriptedExecutor([
			{ match: (a) => a[0] === 'init', result: ok() },
			{ match: (a) => a[0] === 'remote', result: ok() },
			// Non-empty ref listing forces the symref-HEAD resolution.
			{
				match: (a) => a[0] === 'ls-remote' && !a.includes('--symref'),
				result: ok('deadbeef\trefs/heads/x\n'),
			},
			// symref HEAD returns no parseable `ref: refs/heads/<name>` line.
			{
				match: (a) => a[0] === 'ls-remote' && a.includes('--symref'),
				result: ok('deadbeef\tHEAD\n'),
			},
		]);
		const res = await connectExistingRepo(scripted, 'file:///x', repoLoc(dir), true);
		expect(res.success).toBe(false);
		expect(res.error).toMatch(/could not determine the remote default branch/);
	});
});
