import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { RepoHostType } from '@hezo/shared';
import type { GitExecutor } from './git-executor';

/**
 * A repo clone, addressed by both its host path (for `node:fs` checks against the
 * bind-mounted directory) and its in-container path (the cwd git runs in). In unit
 * tests the two are the same temp dir.
 */
export interface RepoLoc {
	hostPath: string;
	containerPath: string;
}

/** A task worktree, addressed the same way as {@link RepoLoc}. */
export interface WorktreeLoc {
	hostPath: string;
	containerPath: string;
}

function formatGitError(stderr: string): string {
	return stderr.trim();
}

const SSH_HOSTS: Record<RepoHostType, string> = {
	[RepoHostType.GitHub]: 'github.com',
};

export function buildGitSshUrl(hostType: RepoHostType, repoIdentifier: string): string {
	const host = SSH_HOSTS[hostType];
	if (!host) throw new Error(`Unsupported repo host type: ${hostType}`);
	return `git@${host}:${repoIdentifier}.git`;
}

export async function cloneRepo(
	executor: GitExecutor,
	repoIdentifier: string,
	target: RepoLoc,
	hostType: RepoHostType = RepoHostType.GitHub,
): Promise<{ success: boolean; error?: string }> {
	const url = buildGitSshUrl(hostType, repoIdentifier);
	const { exitCode, stderr } = await executor.exec(['clone', url, target.containerPath], {
		cwd: dirname(target.containerPath),
		needsSsh: true,
		timeout: 120_000,
	});
	if (exitCode !== 0) return { success: false, error: formatGitError(stderr) };
	return { success: true };
}

/**
 * Connects an existing, already-populated directory to a remote — the path
 * `cloneRepo` can't take because `git clone` refuses a non-empty destination.
 * Used when an agent populated the workspace directory reserved for a repo
 * before that repo was connected. When the remote already has commits its
 * content is checked out (existing untracked files that would be overwritten
 * abort rather than clobber either side); when the remote is empty the existing
 * files are kept as the working tree to become the repo's initial content on the
 * first commit/push. A `.git` created here is removed on failure so the
 * directory stays eligible for a clean retry. `needsSsh` gates the network ops
 * (false for the `file://` repos used in tests).
 */
export async function connectExistingRepo(
	executor: GitExecutor,
	url: string,
	target: RepoLoc,
	needsSsh: boolean,
): Promise<{ success: boolean; error?: string }> {
	const cwd = target.containerPath;
	const hadGit = existsSync(join(target.hostPath, '.git'));
	const fail = (error: string): { success: false; error: string } => {
		if (!hadGit) rmSync(join(target.hostPath, '.git'), { recursive: true, force: true });
		return { success: false, error };
	};

	const init = await executor.exec(['init', '-b', 'main'], { cwd, timeout: 30_000 });
	if (init.exitCode !== 0) return fail(formatGitError(init.stderr));

	const remote = await executor.exec(['remote', 'add', 'origin', url], { cwd, timeout: 30_000 });
	if (remote.exitCode !== 0) return fail(formatGitError(remote.stderr));

	// A remote with no refs has no commits yet — keep the existing files as the
	// initial working tree. `ls-remote --symref HEAD` can print a symref line even
	// for an unborn HEAD, so emptiness is judged by the full ref listing.
	const refs = await executor.exec(['ls-remote', 'origin'], { cwd, needsSsh, timeout: 60_000 });
	if (refs.exitCode !== 0) return fail(formatGitError(refs.stderr));

	if (refs.stdout.trim().length > 0) {
		const head = await executor.exec(['ls-remote', '--symref', 'origin', 'HEAD'], {
			cwd,
			needsSsh,
			timeout: 60_000,
		});
		if (head.exitCode !== 0) return fail(formatGitError(head.stderr));
		const branch = head.stdout.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m)?.[1];
		if (!branch) return fail('could not determine the remote default branch');

		const fetch = await executor.exec(['fetch', 'origin', branch], {
			cwd,
			needsSsh,
			timeout: 120_000,
		});
		if (fetch.exitCode !== 0) return fail(formatGitError(fetch.stderr));

		// No `-f`: an existing untracked file that the checkout would overwrite
		// aborts the operation rather than clobbering the agent's work.
		const checkout = await executor.exec(
			['checkout', '-B', branch, '--track', `origin/${branch}`],
			{
				cwd,
				timeout: 60_000,
			},
		);
		if (checkout.exitCode !== 0) return fail(formatGitError(checkout.stderr));
	}

	return { success: true };
}

export async function initRepoInPlace(
	executor: GitExecutor,
	repoIdentifier: string,
	target: RepoLoc,
	hostType: RepoHostType = RepoHostType.GitHub,
): Promise<{ success: boolean; error?: string }> {
	return connectExistingRepo(executor, buildGitSshUrl(hostType, repoIdentifier), target, true);
}

export async function fetchRepo(
	executor: GitExecutor,
	repo: RepoLoc,
): Promise<{ success: boolean; error?: string }> {
	const { exitCode, stderr } = await executor.exec(['fetch', '--all', '--prune'], {
		cwd: repo.containerPath,
		needsSsh: true,
		timeout: 60_000,
	});
	if (exitCode !== 0) return { success: false, error: formatGitError(stderr) };
	return { success: true };
}

/**
 * Resolves the remote's default branch name (e.g. `main`) for a clone, or null
 * when none can be determined (an empty/unborn remote). Prefers the `origin/HEAD`
 * symref recorded at clone time, then probes `origin/main` and `origin/master`
 * so a repo connected in place — which sets no `origin/HEAD` — still resolves.
 * Only ever returns a name whose remote-tracking ref actually exists, so callers
 * can safely use `origin/<name>` as a commit-ish.
 */
export async function getRemoteDefaultBranch(
	executor: GitExecutor,
	repo: RepoLoc,
): Promise<string | null> {
	const cwd = repo.containerPath;
	const candidates: string[] = [];
	const symref = await executor.exec(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
		cwd,
		timeout: 30_000,
	});
	if (symref.exitCode === 0) {
		const name = symref.stdout.trim().replace(/^origin\//, '');
		if (name) candidates.push(name);
	}
	for (const fallback of ['main', 'master']) {
		if (!candidates.includes(fallback)) candidates.push(fallback);
	}

	for (const name of candidates) {
		const exists = await executor.exec(
			['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`],
			{ cwd, timeout: 30_000 },
		);
		if (exists.exitCode === 0) return name;
	}
	return null;
}

/**
 * Brings the clone's local default branch up to the freshly-fetched
 * `origin/<default>` — the "keep the main codebase current" step. Always
 * conflict-free: the clone never has local commits on its default. When that
 * branch is checked out, `merge --ff-only` advances it (and the working tree);
 * otherwise `update-ref` advances the ref without touching any tree. New task
 * worktrees then branch off current trunk. Non-fatal: a failure (incl. an
 * unexpected local divergence) is returned as a warning and the run proceeds.
 */
export async function fastForwardLocalDefault(
	executor: GitExecutor,
	repo: RepoLoc,
): Promise<string | undefined> {
	const cwd = repo.containerPath;
	const def = await getRemoteDefaultBranch(executor, repo);
	if (!def) return undefined;
	const local = `refs/heads/${def}`;
	const remote = `refs/remotes/origin/${def}`;

	const head = await executor.exec(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
		cwd,
		timeout: 30_000,
	});
	if (head.exitCode === 0 && head.stdout.trim() === def) {
		const ff = await executor.exec(['merge', '--ff-only', `origin/${def}`], {
			cwd,
			timeout: 30_000,
		});
		return ff.exitCode === 0
			? undefined
			: `could not fast-forward ${def}: ${formatGitError(ff.stderr)}`;
	}

	// Not checked out: move the ref to the remote tip. Guard against rewinding a
	// local commit that shouldn't exist on the default branch.
	const localExists = await executor.exec(['rev-parse', '--verify', '--quiet', local], {
		cwd,
		timeout: 30_000,
	});
	if (localExists.exitCode === 0) {
		const isAncestor = await executor.exec(['merge-base', '--is-ancestor', local, remote], {
			cwd,
			timeout: 30_000,
		});
		if (isAncestor.exitCode !== 0) {
			return `local ${def} has diverged from origin/${def}; not fast-forwarding`;
		}
	}
	const upd = await executor.exec(['update-ref', local, remote], { cwd, timeout: 30_000 });
	return upd.exitCode === 0
		? undefined
		: `could not fast-forward ${def}: ${formatGitError(upd.stderr)}`;
}

export async function createWorktree(
	executor: GitExecutor,
	repo: RepoLoc,
	wt: WorktreeLoc,
	branchName: string,
): Promise<{ success: boolean; error?: string }> {
	const { exitCode, stderr } = await executor.exec(
		['worktree', 'add', '-b', branchName, wt.containerPath],
		{ cwd: repo.containerPath, timeout: 30_000 },
	);
	if (exitCode !== 0) return { success: false, error: formatGitError(stderr) };
	return { success: true };
}

interface WorktreeListEntry {
	path: string;
	branch?: string;
}

async function listWorktrees(executor: GitExecutor, repo: RepoLoc): Promise<WorktreeListEntry[]> {
	const res = await executor.exec(['worktree', 'list', '--porcelain'], {
		cwd: repo.containerPath,
		timeout: 30_000,
	});
	if (res.exitCode !== 0) return [];
	const entries: WorktreeListEntry[] = [];
	let current: WorktreeListEntry | null = null;
	for (const line of res.stdout.split('\n')) {
		if (line.startsWith('worktree ')) {
			if (current) entries.push(current);
			current = { path: line.slice('worktree '.length).trim() };
		} else if (line.startsWith('branch ') && current) {
			current.branch = line.slice('branch '.length).trim();
		}
	}
	if (current) entries.push(current);
	return entries;
}

/**
 * A branch can be checked out in at most one worktree, so a stale checkout
 * anywhere in the clone blocks recreating the task worktree. Strays come from
 * runs that died mid-task — e.g. a worktree the agent created inside the clone.
 * Unregisters every holder of the branch: unresolvable registrations are
 * pruned, linked worktrees are force-removed, and a checkout in the main
 * worktree is detached. Committed work survives on the branch ref.
 */
async function releaseBranchFromWorktrees(
	executor: GitExecutor,
	repo: RepoLoc,
	branchName: string,
): Promise<void> {
	const cwd = repo.containerPath;
	await executor.exec(['worktree', 'prune', '--expire', 'now'], { cwd, timeout: 30_000 });

	const entries = await listWorktrees(executor, repo);
	const ref = `refs/heads/${branchName}`;
	for (const [i, entry] of entries.entries()) {
		if (entry.branch !== ref) continue;
		if (i === 0) {
			// The main worktree holds the branch; detach HEAD to free it.
			await executor.exec(['checkout', '--detach'], { cwd, timeout: 30_000 });
		} else {
			await executor.exec(['worktree', 'remove', '--force', '--force', entry.path], {
				cwd,
				timeout: 30_000,
			});
		}
	}
}

/**
 * Adds a worktree for the task branch, choosing the checkout source by what
 * already exists: an existing local branch is checked out as-is (preserving its
 * commits — the case when rebuilding a worktree whose metadata was lost), an
 * existing remote branch is tracked, otherwise a **new** branch is created off the
 * latest fetched remote default branch (`origin/<default>`) so every task starts
 * from current trunk. Only when no default branch resolves (an empty remote) does
 * it fall back to HEAD.
 */
async function addTaskWorktree(
	executor: GitExecutor,
	repo: RepoLoc,
	wt: WorktreeLoc,
	branchName: string,
): Promise<{ success: boolean; created: boolean; error?: string }> {
	await releaseBranchFromWorktrees(executor, repo, branchName);
	const cwd = repo.containerPath;

	const localBranch = await executor.exec(
		['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`],
		{ cwd, timeout: 30_000 },
	);
	const remoteBranch = await executor.exec(['rev-parse', '--verify', `origin/${branchName}`], {
		cwd,
		timeout: 30_000,
	});

	let args: string[];
	if (localBranch.exitCode === 0) {
		args = ['worktree', 'add', wt.containerPath, branchName];
	} else if (remoteBranch.exitCode === 0) {
		args = [
			'worktree',
			'add',
			'--track',
			'-b',
			branchName,
			wt.containerPath,
			`origin/${branchName}`,
		];
	} else {
		const def = await getRemoteDefaultBranch(executor, repo);
		args = def
			? ['worktree', 'add', '-b', branchName, wt.containerPath, `origin/${def}`]
			: ['worktree', 'add', '-b', branchName, wt.containerPath];
	}

	const result = await executor.exec(args, { cwd, timeout: 30_000 });
	if (result.exitCode !== 0) {
		return { success: false, created: false, error: formatGitError(result.stderr) };
	}
	return { success: true, created: true };
}

export async function ensureTaskWorktree(
	executor: GitExecutor,
	repo: RepoLoc,
	wt: WorktreeLoc,
	branchName: string,
): Promise<{ success: boolean; created: boolean; error?: string }> {
	if (existsSync(join(wt.hostPath, '.git'))) {
		// Reuse the existing worktree when its gitdir still resolves in the container.
		const probe = await executor.exec(['rev-parse', '--git-dir'], {
			cwd: wt.containerPath,
			timeout: 30_000,
		});
		if (probe.exitCode === 0) {
			return { success: true, created: false };
		}
		// The tree survived but its admin entry was lost (e.g. the clone was
		// recreated). Discard the stale tree and rebuild from the branch ref, which
		// still lives in the clone — committed work is preserved.
		rmSync(wt.hostPath, { recursive: true, force: true });
		await pruneWorktrees(executor, repo);
	}

	return addTaskWorktree(executor, repo, wt, branchName);
}

export async function pruneWorktrees(executor: GitExecutor, repo: RepoLoc): Promise<void> {
	await executor.exec(['worktree', 'prune', '--expire', 'now'], {
		cwd: repo.containerPath,
		timeout: 30_000,
	});
}

/**
 * Resolve the current commit a worktree points at, or null if the worktree is
 * missing or has no commit (e.g. an unborn branch). Captured before a run so a
 * post-run comparison can tell whether the agent advanced the branch.
 */
export async function getWorktreeHead(
	executor: GitExecutor,
	wt: WorktreeLoc,
): Promise<string | null> {
	if (!existsSync(join(wt.hostPath, '.git'))) return null;
	const { exitCode, stdout } = await executor.exec(['rev-parse', 'HEAD'], {
		cwd: wt.containerPath,
		timeout: 10_000,
	});
	return exitCode === 0 ? stdout.trim() || null : null;
}

/**
 * Whether a run changed code in this worktree: any uncommitted/untracked change
 * (`git status --porcelain` non-empty), or the branch tip advanced past the
 * commit captured before the run.
 */
export async function worktreeHasChanges(
	executor: GitExecutor,
	wt: WorktreeLoc,
	headBefore: string | null,
): Promise<boolean> {
	if (!existsSync(join(wt.hostPath, '.git'))) return false;
	const status = await executor.exec(['status', '--porcelain'], {
		cwd: wt.containerPath,
		timeout: 10_000,
	});
	if (status.exitCode === 0 && status.stdout.trim().length > 0) return true;
	const headAfter = await getWorktreeHead(executor, wt);
	return headAfter !== null && headBefore !== null && headAfter !== headBefore;
}
