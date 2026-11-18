import { execSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
	clearPushErrors,
	ensurePushHook,
	localGitLoc,
	POST_COMMIT_PUSH_HOOK,
	PUSH_ERROR_LOG_NAME,
	PUSHED_MARKER_PREFIX,
	type RepoLoc,
	readPushErrors,
} from '../src/services/git';
import { HostGitExecutor } from '../src/services/git-executor';

// These tests exercise the REAL `post-commit` auto-push hook end-to-end with local
// `git` and a bare `origin` — no Docker/SSH. The hook keys off a live `SSH_AUTH_SOCK`
// (present during an agent's bridged run, absent during Hezo's bare prep git ops), so
// the tests stand up an actual listening unix socket to drive the "push fires" path and
// omit it to drive the "push skipped" path.

const root = mkdtempSync(join(tmpdir(), 'git-hook-'));
const repoLoc = (p: string): RepoLoc => localGitLoc(p);
const sockets: Array<() => Promise<void>> = [];

afterAll(async () => {
	await Promise.all(sockets.map((close) => close()));
	rmSync(root, { recursive: true, force: true });
});

function run(cmd: string, cwd?: string, env?: NodeJS.ProcessEnv) {
	execSync(cmd, { cwd, stdio: 'pipe', env });
}
function sha(cwd: string, rev = 'HEAD'): string {
	return execSync(`git rev-parse ${rev}`, { cwd }).toString().trim();
}
function configure(dir: string) {
	run('git config user.name tester', dir);
	run('git config user.email tester@test.com', dir);
	run('git config commit.gpgsign false', dir);
}
/**
 * The tip the hook recorded as accepted by origin, or null if it recorded none. This
 * is the half of the durability check that outlives the remote branch: deleting the
 * branch (or squash-merging it) prunes the tracking ref, and this ref is what still
 * says the commits were delivered.
 */
function markerSha(clone: string, branch: string): string | null {
	try {
		return execSync(`git rev-parse --verify ${PUSHED_MARKER_PREFIX}${branch}`, {
			cwd: clone,
			stdio: 'pipe',
		})
			.toString()
			.trim();
	} catch {
		return null;
	}
}
function remoteHasRef(bare: string, branch: string): boolean {
	try {
		execSync(`git show-ref --verify --quiet refs/heads/${branch}`, { cwd: bare, stdio: 'pipe' });
		return true;
	} catch {
		return false;
	}
}
async function liveSocket(dir: string): Promise<string> {
	const path = join(dir, 'agent.sock');
	const server = net.createServer();
	await new Promise<void>((resolve) => server.listen(path, () => resolve()));
	sockets.push(() => new Promise<void>((r) => server.close(() => r())));
	return path;
}

// A clone with the hook installed, on a fresh `hezo/<task>` branch, pointed at a bare
// origin — the shape repo prep (`prepare_repos`) produces for a task run.
async function setupClone(name: string, branch: string): Promise<{ clone: string; bare: string }> {
	const bare = join(root, `${name}.git`);
	const clone = join(root, `${name}-clone`);
	run(`git init --bare -b main ${bare}`);
	run(`git clone ${bare} ${clone}`);
	configure(clone);
	run(`git checkout -b ${branch}`, clone);
	await ensurePushHook(repoLoc(clone));
	return { clone, bare };
}

describe('ensurePushHook (install)', () => {
	it('writes an executable post-commit hook whose content is the durability script', async () => {
		const dir = join(root, 'install');
		run(`git init -b main ${dir}`);
		await ensurePushHook(repoLoc(dir));

		const hookPath = join(dir, '.git', 'hooks', 'post-commit');
		expect(readFileSync(hookPath, 'utf8')).toBe(POST_COMMIT_PUSH_HOOK);
		expect(statSync(hookPath).mode & 0o777).toBe(0o755);
	});

	it('is idempotent — a second call leaves an executable hook with the same content', async () => {
		const dir = join(root, 'install-idempotent');
		run(`git init -b main ${dir}`);
		await ensurePushHook(repoLoc(dir));
		await ensurePushHook(repoLoc(dir));

		const hookPath = join(dir, '.git', 'hooks', 'post-commit');
		expect(readFileSync(hookPath, 'utf8')).toBe(POST_COMMIT_PUSH_HOOK);
		expect(statSync(hookPath).mode & 0o777).toBe(0o755);
	});

	it('creates the hooks dir if it is missing and never throws', async () => {
		const dir = join(root, 'install-no-hooks');
		mkdirSync(join(dir, '.git'), { recursive: true });
		await expect(ensurePushHook(repoLoc(dir))).resolves.toBeUndefined();
		expect(statSync(join(dir, '.git', 'hooks', 'post-commit')).isFile()).toBe(true);
	});

	it("removes the clone's own push-error file, which no run reads any more", async () => {
		// Every failure used to land in this one file, shared by every run on the
		// clone. Now only a commit in the clone's own checkout writes it, so prep
		// keeps it from growing - including the copy a previous release left.
		const dir = join(root, 'install-legacy-log');
		run(`git init -b main ${dir}`);
		writeFileSync(join(dir, '.git', PUSH_ERROR_LOG_NAME), '=== auto-push failed: old\n');

		await ensurePushHook(repoLoc(dir));

		expect(existsSync(join(dir, '.git', PUSH_ERROR_LOG_NAME))).toBe(false);
	});
});

describe('post-commit auto-push', () => {
	it('pushes each commit to origin when a live SSH agent socket is present', async () => {
		const branch = 'hezo/AUTO-1';
		const { clone, bare } = await setupClone('push', branch);
		const sock = await liveSocket(join(root, 'push-clone'));

		run('git commit --allow-empty -m first', clone, { ...process.env, SSH_AUTH_SOCK: sock });

		expect(remoteHasRef(bare, branch)).toBe(true);
		expect(sha(bare, branch)).toBe(sha(clone, 'HEAD'));
		// The accepted tip is recorded where no later delete or squash can retract it.
		expect(markerSha(clone, branch)).toBe(sha(clone, 'HEAD'));

		// A second commit fast-forwards the remote branch to the new tip.
		run('git commit --allow-empty -m second', clone, { ...process.env, SSH_AUTH_SOCK: sock });
		expect(sha(bare, branch)).toBe(sha(clone, 'HEAD'));
		expect(markerSha(clone, branch)).toBe(sha(clone, 'HEAD'));
	});

	it('does not push (but the commit still succeeds) when there is no live SSH socket', async () => {
		const branch = 'hezo/AUTO-2';
		const { clone, bare } = await setupClone('nosock', branch);

		// SSH_AUTH_SOCK empty → `[ -S "$SSH_AUTH_SOCK" ]` is false → hook exits before pushing.
		run('git commit --allow-empty -m first', clone, { ...process.env, SSH_AUTH_SOCK: '' });

		expect(sha(clone, 'HEAD')).toBeTruthy(); // commit landed locally
		expect(remoteHasRef(bare, branch)).toBe(false); // nothing pushed
		expect(markerSha(clone, branch)).toBeNull(); // and nothing claimed as delivered
	});

	it('is a no-op (commit still succeeds) when the repo has no origin remote', async () => {
		const dir = join(root, 'noremote');
		run(`git init -b hezo/AUTO-3 ${dir}`);
		configure(dir);
		await ensurePushHook(repoLoc(dir));
		const sock = await liveSocket(join(root, 'noremote'));

		expect(() =>
			run('git commit --allow-empty -m first', dir, { ...process.env, SSH_AUTH_SOCK: sock }),
		).not.toThrow();
		expect(sha(dir, 'HEAD')).toBeTruthy();
	});
});

// A denied push used to be discarded to /dev/null, so it produced exactly the same
// output as a clean one: the agent had no signal its commits weren't leaving the
// container, and neither did the human reading the run log afterwards. These pin the
// reporting down — loud in both directions, and still never fatal to the commit.
describe('post-commit auto-push failure reporting', () => {
	// `origin` points at a path that is not a repository, so the push fails the way a
	// permission denial does: non-zero exit with a message on stderr.
	async function setupBrokenOrigin(name: string, branch: string): Promise<string> {
		const clone = join(root, `${name}-clone`);
		run(`git init -b main ${clone}`);
		configure(clone);
		run(`git remote add origin ${join(root, `${name}-missing.git`)}`, clone);
		run('git commit --allow-empty -m base', clone, { ...process.env, SSH_AUTH_SOCK: '' });
		run(`git checkout -b ${branch}`, clone);
		await ensurePushHook(repoLoc(clone));
		return clone;
	}

	it('reports a failed push on stderr and still lets the commit succeed', async () => {
		const clone = await setupBrokenOrigin('pushfail', 'hezo/AUTO-4');
		const sock = await liveSocket(clone);

		const before = sha(clone, 'HEAD');
		const output = execSync('git commit --allow-empty -m doomed 2>&1', {
			cwd: clone,
			env: { ...process.env, SSH_AUTH_SOCK: sock },
		}).toString();

		// The commit is never blocked by a reporting hook.
		expect(sha(clone, 'HEAD')).not.toBe(before);
		expect(output).toContain('auto-push');
		expect(output).toContain('local only');
		// Nothing reached origin, so nothing may be recorded as having done so — a
		// marker written here would report a stranded branch as safely delivered.
		expect(markerSha(clone, 'hezo/AUTO-4')).toBeNull();
	});

	// The production path: the agent commits inside its task's worktree, never the
	// clone itself. Each worktree keeps its own record, in its own admin entry.
	const exec = new HostGitExecutor();
	function addWorktree(clone: string, name: string, branch: string) {
		const path = join(root, name);
		run(`git worktree add -b ${branch} ${path}`, clone);
		configure(path);
		return localGitLoc(path);
	}
	function commitIn(dir: string, sock: string, message = 'doomed') {
		run(`git commit --allow-empty -m ${message}`, dir, { ...process.env, SSH_AUTH_SOCK: sock });
	}

	it("records the git error in the worktree's own record for the runner to surface", async () => {
		const clone = await setupBrokenOrigin('pushlog', 'hezo/AUTO-5');
		const wt = addWorktree(clone, 'pushlog-wt', 'hezo/AUTO-5W');
		const sock = await liveSocket(clone);

		expect(await readPushErrors(exec, wt)).toBeNull();
		commitIn(wt.containerPath, sock);

		const errors = await readPushErrors(exec, wt);
		expect(errors).toContain('auto-push failed');
		expect(errors).toContain('hezo/AUTO-5W');
		// The real git output is kept, not just the fact that something failed —
		// "Permission to <repo> denied to <account>" is the whole diagnosis.
		expect(errors).toMatch(/does not appear to be a git repository|repository not found/i);
	});

	it('writes nothing to the record when the push succeeds', async () => {
		const { clone } = await setupClone('pushclean', 'hezo/AUTO-6');
		const wt = addWorktree(clone, 'pushclean-wt', 'hezo/AUTO-6W');
		const sock = await liveSocket(join(root, 'pushclean-clone'));

		commitIn(wt.containerPath, sock, 'fine');
		expect(await readPushErrors(exec, wt)).toBeNull();
	});

	it('clearPushErrors scopes the record to the current run', async () => {
		const clone = await setupBrokenOrigin('pushclear', 'hezo/AUTO-7');
		const wt = addWorktree(clone, 'pushclear-wt', 'hezo/AUTO-7W');
		const sock = await liveSocket(clone);

		commitIn(wt.containerPath, sock);
		expect(await readPushErrors(exec, wt)).not.toBeNull();

		// Run prep clears it, so the next run never reports a previous run's failures.
		await clearPushErrors(exec, wt);
		expect(await readPushErrors(exec, wt)).toBeNull();
		// Clearing an already-absent record is fine.
		await expect(clearPushErrors(exec, wt)).resolves.toBeUndefined();
	});

	it("clearing one task's record leaves another task's record in the same clone alone", async () => {
		// On a backend that shares one workspace, every run of a project uses the
		// same clone. Run B's prep clears B's record; run A, still mid-run on
		// another task, must still find its failed push at its own finalize.
		const clone = await setupBrokenOrigin('pushtwo', 'hezo/AUTO-8');
		const taskA = addWorktree(clone, 'pushtwo-a', 'hezo/AUTO-8A');
		const taskB = addWorktree(clone, 'pushtwo-b', 'hezo/AUTO-8B');
		const sock = await liveSocket(clone);

		commitIn(taskA.containerPath, sock);
		commitIn(taskB.containerPath, sock);
		await clearPushErrors(exec, taskB);

		expect(await readPushErrors(exec, taskB)).toBeNull();
		const errors = await readPushErrors(exec, taskA);
		expect(errors).toContain('hezo/AUTO-8A');
		// And never the other task's failure.
		expect(errors).not.toContain('hezo/AUTO-8B');
	});

	it("does not report a commit in the clone's own checkout as any task's failure", async () => {
		const clone = await setupBrokenOrigin('pushmain', 'hezo/AUTO-9');
		const wt = addWorktree(clone, 'pushmain-wt', 'hezo/AUTO-9W');
		const sock = await liveSocket(clone);

		commitIn(clone, sock);

		expect(await readPushErrors(exec, wt)).toBeNull();
	});

	it('readPushErrors returns null for a folder that is not a task worktree', async () => {
		const dir = join(root, 'never-failed');
		run(`git init -b main ${dir}`);
		// A `.git` directory, not a gitfile: there is no worktree record to read.
		expect(await readPushErrors(exec, localGitLoc(dir))).toBeNull();
		expect(await readPushErrors(exec, localGitLoc(join(root, 'no-such-dir')))).toBeNull();
	});
});
