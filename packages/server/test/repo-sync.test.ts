import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import {
	type GitExecOpts,
	type GitExecResult,
	type GitExecutor,
	HostGitExecutor,
} from '../src/services/git-executor';
import {
	ensureProjectRepos,
	type LogEmitter,
	type RepoSyncResult,
	removeRepoFromWorkspace,
	removeTaskWorktrees,
} from '../src/services/repo-sync';
import { hostSandboxFiles } from '../src/services/sandbox/files';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let teamId: string;
let projectId: string;
let dataDir: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	dataDir = ctx.dataDir;

	const teamRes = await createTestTeam(db, { name: 'Repo Sync Co' });
	const team = (await teamRes.json()).data;
	teamId = team.id;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Main',
		description: 'Test project.',
	});
	const project = (await projectRes.json()).data;
	projectId = project.id;
});

afterAll(async () => {
	await safeClose(db);
});

// Neutralize ambient URL rewrites (CI proxies inject `url.*.insteadOf` via
// GIT_CONFIG_* env and global/system config) so origin URLs read back exactly
// as stored — the executor sees what production's clean container git would.
const HERMETIC_GIT_ENV = {
	GIT_CONFIG_COUNT: '0',
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_CONFIG_SYSTEM: '/dev/null',
};

// Git runs against host temp dirs here (host and container paths coincide via
// the containerWorkspaceRoot override), so the clone-over-SSH path is never
// exercised — tests cover the skip and self-heal classification of
// already-on-disk directories.
const exec = new HostGitExecutor(HERMETIC_GIT_ENV);

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, {
		cwd,
		stdio: 'pipe',
		env: { ...process.env, ...HERMETIC_GIT_ENV },
	}).toString();
}

/** A real git repo at `dir`, optionally with an `origin` remote configured. */
function makeRepo(dir: string, originUrl?: string): void {
	mkdirSync(dir, { recursive: true });
	git(dir, 'init', '-b', 'main');
	if (originUrl) git(dir, 'remote', 'add', 'origin', originUrl);
}

/** The raw stored origin URL — unaffected by any insteadOf display rewriting. */
function rawOriginUrl(dir: string): string {
	return git(dir, 'config', '--get', 'remote.origin.url').trim();
}

/**
 * Delegates to real host git but answers `ls-remote` with an empty ref listing —
 * the empty-remote shape — so the adopt-in-place heal path completes without any
 * network. Everything the heal does besides `ls-remote` is a local operation.
 */
class EmptyRemoteExecutor implements GitExecutor {
	/** Temp dirs, so host and container paths are the same string. */
	files(containerPath: string) {
		return hostSandboxFiles(containerPath);
	}
	private readonly inner = new HostGitExecutor(HERMETIC_GIT_ENV);
	exec(args: string[], opts: GitExecOpts): Promise<GitExecResult> {
		if (args[0] === 'ls-remote') {
			return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
		}
		return this.inner.exec(args, opts);
	}
}

/** Answers every git call with a zero-exit and no output — the stubbed-docker shape. */
class SilentExecutor implements GitExecutor {
	/** Temp dirs, so host and container paths are the same string. */
	files(containerPath: string) {
		return hostSandboxFiles(containerPath);
	}
	calls: string[][] = [];
	exec(args: string[]): Promise<GitExecResult> {
		this.calls.push(args);
		return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
	}
}

async function withRepo(
	identifier: string,
	fn: (
		targetDir: string,
		sync: (
			executor: GitExecutor,
			logEmit?: LogEmitter,
			opts?: { freshClone?: ReadonlySet<string> },
		) => Promise<RepoSyncResult>,
	) => Promise<void>,
): Promise<void> {
	await db.query(
		`INSERT INTO repos (project_id, repo_identifier, host_type)
		 VALUES ($1, $2, 'github'::repo_host_type)`,
		[projectId, identifier],
	);
	const workspacePath = join(dataDir, 'teams', teamId, 'projects', projectId, 'workspace');
	try {
		await fn(join(workspacePath, identifier.split('/')[1]), (executor, logEmit, opts) =>
			// Host and "container" paths coincide: the executor runs host git, so the
			// workspace path doubles as the container workspace root.
			ensureProjectRepos(
				db,
				{ id: projectId, team_id: teamId },
				dataDir,
				executor,
				logEmit,
				workspacePath,
				opts,
			),
		);
	} finally {
		await db.query('DELETE FROM repos WHERE project_id = $1 AND repo_identifier = $2', [
			projectId,
			identifier,
		]);
	}
}

describe('ensureProjectRepos', () => {
	it('returns empty result when no repos are linked', async () => {
		const result = await ensureProjectRepos(db, { id: projectId, team_id: teamId }, dataDir, exec);
		expect(result.cloned).toEqual([]);
		expect(result.repaired).toEqual([]);
		expect(result.skipped).toEqual([]);
		expect(result.failed).toEqual([]);
	});

	it('re-clones a repo the operator asked to replace, instead of adopting it', async () => {
		// The reset route's `reclone`. It used to work by deleting the host clone
		// directory before calling in, which selected `clone` below only because the
		// mode check was a host check too. The check now asks the container, so the
		// removal has to happen on that side or the sync adopts the very clone it
		// was told to replace - which on a managed backend is what happened, while
		// the action reported success.
		await withRepo('owner/staleclone', async (targetDir, sync) => {
			makeRepo(targetDir, 'https://github.com/owner/staleclone.git');
			writeFileSync(join(targetDir, 'leftover.txt'), 'from the clone being replaced');

			// Without the request this is a no-op: origin is already correct.
			expect((await sync(exec)).skipped).toContain('staleclone');

			// With it, the existing clone is gone before the sync decides - the
			// silent executor stands in for the clone itself, which needs a network.
			const executor = new SilentExecutor();
			const result = await sync(executor, undefined, {
				freshClone: new Set(['owner/staleclone']),
			});

			expect(result.cloned).toContain('staleclone');
			expect(result.skipped).toEqual([]);
			expect(result.repaired).toEqual([]);
			// The old working tree is really gone, not merely re-pointed.
			expect(existsSync(join(targetDir, 'leftover.txt'))).toBe(false);
			expect(existsSync(join(targetDir, '.git'))).toBe(false);
			// And the git command actually issued was a clone.
			expect(executor.calls.some((c) => c[0] === 'clone')).toBe(true);
		});
	});

	it("clears the replaced repo's worktrees, which point into the clone it just deleted", async () => {
		// They are `git worktree` checkouts *of* that clone: once its .git is gone
		// their admin files dangle, and a later worktree add for the same task would
		// collide with the orphan.
		await withRepo('owner/wtclone', async (targetDir, sync) => {
			makeRepo(targetDir, 'https://github.com/owner/wtclone.git');
			const worktreesRoot = join(dataDir, 'teams', teamId, 'projects', projectId, 'worktrees');
			const taskWorktree = join(worktreesRoot, 'TASK-1', 'wtclone');
			mkdirSync(taskWorktree, { recursive: true });
			writeFileSync(join(taskWorktree, 'checked-out.txt'), 'x');
			// A sibling repo's worktree under the same task must survive - only the
			// repo being recloned is in scope.
			const otherWorktree = join(worktreesRoot, 'TASK-1', 'unrelated');
			mkdirSync(otherWorktree, { recursive: true });
			writeFileSync(join(otherWorktree, 'keep.txt'), 'y');

			await sync(new SilentExecutor(), undefined, { freshClone: new Set(['owner/wtclone']) });

			expect(existsSync(taskWorktree)).toBe(false);
			expect(existsSync(join(otherWorktree, 'keep.txt'))).toBe(true);
		});
	});

	it('skips a clone whose origin already points at the linked repo', async () => {
		await withRepo('owner/preexisting', async (targetDir, sync) => {
			makeRepo(targetDir, 'https://github.com/owner/preexisting.git');

			const result = await sync(exec);
			expect(result.skipped).toContain('preexisting');
			expect(result.repaired).toEqual([]);
			expect(result.cloned).toEqual([]);
		});
	});

	it('skips a clone whose origin is the https form of the linked repo', async () => {
		await withRepo('owner/https-form', async (targetDir, sync) => {
			makeRepo(targetDir, 'https://github.com/owner/https-form.git');

			const result = await sync(exec);
			expect(result.skipped).toContain('https-form');
			expect(result.repaired).toEqual([]);
		});
	});

	// The production incident: an agent ran `git init` in the reserved directory
	// before the repo was connected, leaving a repo with no origin and an unborn
	// HEAD. Every fetch then silently no-oped and worktree prep died on
	// "failed to resolve HEAD as a valid ref". The sync must detect and heal it.
	it('heals a stray git init (no origin) by adopting the directory in place', async () => {
		await withRepo('owner/stray', async (targetDir, sync) => {
			makeRepo(targetDir); // no origin, no commits — an agent's bare `git init`
			writeFileSync(join(targetDir, 'draft.md'), 'agent draft\n');

			const logs: Array<{ stream: string; text: string }> = [];
			const result = await sync(new EmptyRemoteExecutor(), (stream, text) =>
				logs.push({ stream, text }),
			);

			expect(result.repaired).toContain('stray');
			expect(result.skipped).not.toContain('stray');
			expect(result.failed).toEqual([]);
			// Origin now tracks the linked repo, and the agent's draft survived.
			expect(rawOriginUrl(targetDir)).toBe('https://github.com/owner/stray.git');
			expect(readFileSync(join(targetDir, 'draft.md'), 'utf8')).toBe('agent draft\n');
			expect(logs.some((l) => l.text.includes('Repairing owner/stray'))).toBe(true);
		});
	});

	it('repoints a clone left on the retired SSH transport', async () => {
		// How every pre-HTTPS clone migrates: no migration, nothing stored to
		// change, just the next sync noticing that `origin` is not the URL Hezo
		// would write. The permissive matcher this replaced accepted the scp form,
		// so these clones kept "matching" and stayed on a transport that cannot
		// reach GitHub from a managed sandbox at all.
		await withRepo('owner/legacyssh', async (targetDir, sync) => {
			makeRepo(targetDir, 'git@github.com:owner/legacyssh.git');

			const result = await sync(exec);
			expect(result.repaired).toContain('legacyssh');
			expect(result.failed).toEqual([]);
			expect(rawOriginUrl(targetDir)).toBe('https://github.com/owner/legacyssh.git');
		});
	});

	it('leaves an HTTPS origin that already tracks the repo alone', async () => {
		await withRepo('owner/alreadyhttps', async (targetDir, sync) => {
			makeRepo(targetDir, 'https://github.com/owner/alreadyhttps.git');
			const result = await sync(exec);
			expect(result.skipped).toContain('alreadyhttps');
			expect(result.repaired).toEqual([]);
		});
	});

	it('repoints an origin configured at the wrong repo', async () => {
		await withRepo('owner/repointed', async (targetDir, sync) => {
			makeRepo(targetDir, 'https://github.com/someone/else.git');

			const result = await sync(exec);
			expect(result.repaired).toContain('repointed');
			expect(result.failed).toEqual([]);
			expect(rawOriginUrl(targetDir)).toBe('https://github.com/owner/repointed.git');
		});
	});

	// An executor that can't produce a definitive answer (a stubbed docker, a
	// transport failure) must never trigger a "repair" of a possibly-healthy
	// clone — the dir is left untouched and reported as skipped.
	it('leaves the clone alone when the origin check is indeterminate', async () => {
		await withRepo('owner/indeterminate', async (targetDir, sync) => {
			makeRepo(targetDir); // no origin — but the executor can't see that
			const silent = new SilentExecutor();

			const result = await sync(silent);
			expect(result.skipped).toContain('indeterminate');
			expect(result.repaired).toEqual([]);
			expect(result.failed).toEqual([]);
			// Only the read happened; no mutating git call was issued.
			expect(silent.calls).toEqual([['remote', 'get-url', 'origin']]);
		});
	});
});

describe('removeRepoFromWorkspace', () => {
	it('removes the repo subdirectory and its per-task worktrees', async () => {
		const workspacePath = join(dataDir, 'teams', teamId, 'projects', projectId, 'workspace');
		const worktreesPath = join(dataDir, 'teams', teamId, 'projects', projectId, 'worktrees');

		const repoDir = join(workspacePath, 'to-remove');
		mkdirSync(join(repoDir, '.git'), { recursive: true });

		const wtDir1 = join(worktreesPath, 'RS-1', 'to-remove');
		const wtDir2 = join(worktreesPath, 'RS-2', 'to-remove');
		mkdirSync(wtDir1, { recursive: true });
		mkdirSync(wtDir2, { recursive: true });

		removeRepoFromWorkspace(dataDir, teamId, projectId, 'to-remove');

		expect(existsSync(repoDir)).toBe(false);
		expect(existsSync(wtDir1)).toBe(false);
		expect(existsSync(wtDir2)).toBe(false);
	});

	it('is a no-op for dangerous repo name values', () => {
		const workspacePath = join(dataDir, 'teams', teamId, 'projects', projectId, 'workspace');
		const stayDir = join(workspacePath, 'stay');
		mkdirSync(stayDir, { recursive: true });

		removeRepoFromWorkspace(dataDir, teamId, projectId, '..');
		removeRepoFromWorkspace(dataDir, teamId, projectId, 'has/slash');
		removeRepoFromWorkspace(dataDir, teamId, projectId, '');

		expect(existsSync(stayDir)).toBe(true);
	});
});

describe('removeTaskWorktrees', () => {
	it('removes the task directory under worktrees', () => {
		const worktreesPath = join(dataDir, 'teams', teamId, 'projects', projectId, 'worktrees');
		const taskDir = join(worktreesPath, 'RS-9');
		mkdirSync(join(taskDir, 'main'), { recursive: true });
		mkdirSync(join(taskDir, 'secondary'), { recursive: true });

		removeTaskWorktrees(dataDir, teamId, projectId, 'RS-9');

		expect(existsSync(taskDir)).toBe(false);
	});

	it('is a no-op for dangerous identifier values', () => {
		const worktreesPath = join(dataDir, 'teams', teamId, 'projects', projectId, 'worktrees');
		const stayDir = join(worktreesPath, 'RS-10');
		mkdirSync(stayDir, { recursive: true });

		removeTaskWorktrees(dataDir, teamId, projectId, '..');
		removeTaskWorktrees(dataDir, teamId, projectId, '');

		expect(existsSync(stayDir)).toBe(true);
	});
});
