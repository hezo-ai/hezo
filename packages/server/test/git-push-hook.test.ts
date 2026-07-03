import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ensurePushHook, POST_COMMIT_PUSH_HOOK, type RepoLoc } from '../src/services/git';

// These tests exercise the REAL `post-commit` auto-push hook end-to-end with local
// `git` and a bare `origin` — no Docker/SSH. The hook keys off a live `SSH_AUTH_SOCK`
// (present during an agent's bridged run, absent during Hezo's bare prep git ops), so
// the tests stand up an actual listening unix socket to drive the "push fires" path and
// omit it to drive the "push skipped" path.

const root = mkdtempSync(join(tmpdir(), 'git-hook-'));
const repoLoc = (p: string): RepoLoc => ({ hostPath: p, containerPath: p });
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
// origin — the shape prepareWorktrees produces for a task run.
function setupClone(name: string, branch: string): { clone: string; bare: string } {
	const bare = join(root, `${name}.git`);
	const clone = join(root, `${name}-clone`);
	run(`git init --bare -b main ${bare}`);
	run(`git clone ${bare} ${clone}`);
	configure(clone);
	run(`git checkout -b ${branch}`, clone);
	ensurePushHook(repoLoc(clone));
	return { clone, bare };
}

describe('ensurePushHook (install)', () => {
	it('writes an executable post-commit hook whose content is the durability script', () => {
		const dir = join(root, 'install');
		run(`git init -b main ${dir}`);
		ensurePushHook(repoLoc(dir));

		const hookPath = join(dir, '.git', 'hooks', 'post-commit');
		expect(readFileSync(hookPath, 'utf8')).toBe(POST_COMMIT_PUSH_HOOK);
		expect(statSync(hookPath).mode & 0o777).toBe(0o755);
	});

	it('is idempotent — a second call leaves an executable hook with the same content', () => {
		const dir = join(root, 'install-idempotent');
		run(`git init -b main ${dir}`);
		ensurePushHook(repoLoc(dir));
		ensurePushHook(repoLoc(dir));

		const hookPath = join(dir, '.git', 'hooks', 'post-commit');
		expect(readFileSync(hookPath, 'utf8')).toBe(POST_COMMIT_PUSH_HOOK);
		expect(statSync(hookPath).mode & 0o777).toBe(0o755);
	});

	it('creates the hooks dir if it is missing and never throws', () => {
		const dir = join(root, 'install-no-hooks');
		mkdirSync(join(dir, '.git'), { recursive: true });
		expect(() => ensurePushHook(repoLoc(dir))).not.toThrow();
		expect(statSync(join(dir, '.git', 'hooks', 'post-commit')).isFile()).toBe(true);
	});
});

describe('post-commit auto-push', () => {
	it('pushes each commit to origin when a live SSH agent socket is present', async () => {
		const branch = 'hezo/AUTO-1';
		const { clone, bare } = setupClone('push', branch);
		const sock = await liveSocket(join(root, 'push-clone'));

		run('git commit --allow-empty -m first', clone, { ...process.env, SSH_AUTH_SOCK: sock });

		expect(remoteHasRef(bare, branch)).toBe(true);
		expect(sha(bare, branch)).toBe(sha(clone, 'HEAD'));

		// A second commit fast-forwards the remote branch to the new tip.
		run('git commit --allow-empty -m second', clone, { ...process.env, SSH_AUTH_SOCK: sock });
		expect(sha(bare, branch)).toBe(sha(clone, 'HEAD'));
	});

	it('does not push (but the commit still succeeds) when there is no live SSH socket', () => {
		const branch = 'hezo/AUTO-2';
		const { clone, bare } = setupClone('nosock', branch);

		// SSH_AUTH_SOCK empty → `[ -S "$SSH_AUTH_SOCK" ]` is false → hook exits before pushing.
		run('git commit --allow-empty -m first', clone, { ...process.env, SSH_AUTH_SOCK: '' });

		expect(sha(clone, 'HEAD')).toBeTruthy(); // commit landed locally
		expect(remoteHasRef(bare, branch)).toBe(false); // nothing pushed
	});

	it('is a no-op (commit still succeeds) when the repo has no origin remote', async () => {
		const dir = join(root, 'noremote');
		run(`git init -b hezo/AUTO-3 ${dir}`);
		configure(dir);
		ensurePushHook(repoLoc(dir));
		const sock = await liveSocket(join(root, 'noremote'));

		expect(() =>
			run('git commit --allow-empty -m first', dir, { ...process.env, SSH_AUTH_SOCK: sock }),
		).not.toThrow();
		expect(sha(dir, 'HEAD')).toBeTruthy();
	});
});
