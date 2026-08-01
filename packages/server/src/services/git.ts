import { dirname } from 'node:path';
import { RepoHostType } from '@hezo/shared';
import type { GitExecutor } from './git-executor';
import { hostSandboxFiles, type SandboxFiles } from './sandbox/files';

/**
 * A repo clone, addressed the only way that works on every backend: its path
 * *inside the container* (the cwd git runs in) and a {@link SandboxFiles} rooted
 * there.
 *
 * It used to carry a host path too, for `node:fs` checks against the bind-mounted
 * directory. That made every "is this cloned?" question a question about the
 * operator's own disk, which is the same bytes only while the container is local.
 * On a managed backend the clone lives in the sandbox and the host path names an
 * empty directory, so those checks answered "not cloned" for a repo that was
 * cloned - and the run failed with `cannot prepare worktree ... repo is not
 * cloned`, which sends you looking at the repo connection rather than at a
 * filesystem assumption.
 */
export interface RepoLoc {
	containerPath: string;
	/** Reads and writes rooted at {@link containerPath}. */
	files: SandboxFiles;
}

/** A task worktree, addressed the same way as {@link RepoLoc}. */
export interface WorktreeLoc {
	containerPath: string;
	files: SandboxFiles;
}

/**
 * A loc whose container path is also a real host path.
 *
 * True in exactly two places and nowhere else: a unit test pointing both at one
 * temp dir, and the fake engine, where a bind mount genuinely makes the two names
 * the same bytes. Production builds its locs from `ContainerEngine.files`, which
 * is what makes them work on a backend that is not this machine.
 */
export function localGitLoc(dir: string): RepoLoc & WorktreeLoc {
	return { containerPath: dir, files: hostSandboxFiles(dir) };
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

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether a configured remote URL points at the given repo (`owner/repo`) on the
 * given host. Accepts the scp-style SSH form Hezo writes plus the `ssh://` and
 * `http(s)://` forms a human may have configured by hand — a different repo or a
 * different host is a mismatch.
 */
export function remoteUrlMatchesRepo(
	url: string,
	repoIdentifier: string,
	hostType: RepoHostType = RepoHostType.GitHub,
): boolean {
	const host = SSH_HOSTS[hostType];
	if (!host) return false;
	const h = escapeRegExp(host);
	const id = escapeRegExp(repoIdentifier);
	const forms = new RegExp(
		`^(?:git@${h}:|ssh://git@${h}(?::\\d+)?/|https?://(?:[^/@]+@)?${h}/)${id}(?:\\.git)?/?$`,
		'i',
	);
	return forms.test(url.trim());
}

export type OriginRemote =
	/** `origin` is configured and its URL was read. */
	| { status: 'configured'; url: string }
	/** Git positively reported no `origin` (or that the dir is not a git repo). */
	| { status: 'missing' }
	/** No definitive answer — exec transport failure, or zero-exit with no URL. */
	| { status: 'indeterminate' };

/**
 * Reads a clone's `origin` remote URL. `missing` is reserved for git's own
 * definitive answers — "No such remote" (an agent's bare `git init` in the
 * reserved workspace directory) or "not a git repository" (a corrupt `.git`) —
 * both healed by the same adopt-in-place path. Anything else that isn't a
 * readable URL is `indeterminate`: a docker-exec transport failure or a stubbed
 * executor's empty zero-exit is no evidence of misconfiguration, and must never
 * license "repairing" a possibly-healthy clone.
 */
export async function getOriginRemote(executor: GitExecutor, repo: RepoLoc): Promise<OriginRemote> {
	const res = await executor.exec(['remote', 'get-url', 'origin'], {
		cwd: repo.containerPath,
		timeout: 30_000,
	});
	if (res.exitCode !== 0) {
		return /no such remote|not a git repository/i.test(res.stderr)
			? { status: 'missing' }
			: { status: 'indeterminate' };
	}
	const url = res.stdout.trim();
	return url.length > 0 ? { status: 'configured', url } : { status: 'indeterminate' };
}

/**
 * Repoints a clone's `origin` at the repo it is supposed to track. Purely a
 * config change — branches, commits, and the working tree are untouched; the
 * next `git fetch --prune` replaces the stale `origin/*` tracking refs.
 */
export async function setOriginUrl(
	executor: GitExecutor,
	url: string,
	repo: RepoLoc,
): Promise<{ success: boolean; error?: string }> {
	const res = await executor.exec(['remote', 'set-url', 'origin', url], {
		cwd: repo.containerPath,
		timeout: 30_000,
	});
	if (res.exitCode !== 0) return { success: false, error: formatGitError(res.stderr) };
	return { success: true };
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
	const hadGit = await target.files.exists('.git');
	const fail = async (error: string): Promise<{ success: false; error: string }> => {
		// Only tear down a `.git` this call created; one that was already there
		// belongs to the user.
		if (!hadGit) await target.files.removeDir('.git');
		return { success: false, error };
	};

	const init = await executor.exec(['init', '-b', 'main'], { cwd, timeout: 30_000 });
	if (init.exitCode !== 0) return fail(formatGitError(init.stderr));

	// A repaired repo can already carry an `origin` (e.g. one recorded in
	// `.git/config` before the repo broke) — fall back to set-url so the connect
	// is idempotent instead of dying on "remote origin already exists".
	let remote = await executor.exec(['remote', 'add', 'origin', url], { cwd, timeout: 30_000 });
	if (remote.exitCode !== 0) {
		remote = await executor.exec(['remote', 'set-url', 'origin', url], { cwd, timeout: 30_000 });
	}
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

/** The minimal README seeded as an empty repo's initial commit — just the repo name. */
export function initialReadmeContent(repoIdentifier: string): string {
	const name = repoIdentifier.includes('/') ? repoIdentifier.split('/')[1] : repoIdentifier;
	return `# ${name}\n`;
}

/**
 * Bootstraps a connected repo that has no commits yet. `git worktree add` can't
 * base a branch on an unborn HEAD, so an empty remote otherwise fails run prep
 * with the "clone is empty (no commits fetched)" error from {@link addTaskWorktree}.
 * When — and only when — the remote advertises no refs, this writes a minimal
 * README, commits it on `main`, and pushes so the repo gains a default branch and
 * worktrees can be built. Idempotent: a no-op returning `{ seeded: false }` once the
 * remote has any commit, and recoverable — if an earlier call committed locally but
 * its push failed (a transient network error), a later call re-pushes the existing
 * commit instead of re-committing (which would die with "nothing to commit").
 *
 * The commit is deliberately unsigned (`-c commit.gpgsign=false`): SSH commit
 * signing runs `ssh-keygen -Y sign` against `SSH_AUTH_SOCK`, which is only live for
 * bridged (`needsSsh`) ops — a signed local `git commit` here would fail. The push
 * still runs bridged, so it authenticates as the project over the run's SSH bridge.
 * The caller must supply a git identity on the executor env (the prep executor does).
 *
 * A pre-populated working tree (a directory adopted in place) is preserved: the
 * README is only written when absent, and `add -A` folds any existing files into the
 * same initial commit — matching {@link connectExistingRepo}'s "existing files become
 * the initial content" contract. `needsSsh` gates the network ops (false for the
 * `file://` remotes used in tests).
 */
export async function seedInitialCommitIfEmpty(
	executor: GitExecutor,
	repoIdentifier: string,
	repo: RepoLoc,
	needsSsh: boolean,
): Promise<{ seeded: boolean; error?: string }> {
	const cwd = repo.containerPath;

	// Emptiness is judged by the full remote ref listing: `ls-remote --symref HEAD`
	// can print a symref line even for an unborn HEAD (see connectExistingRepo), so a
	// bare `ls-remote` is the authoritative "has any commit" probe.
	const refs = await executor.exec(['ls-remote', 'origin'], { cwd, needsSsh, timeout: 60_000 });
	if (refs.exitCode !== 0) return { seeded: false, error: formatGitError(refs.stderr) };
	if (refs.stdout.trim().length > 0) return { seeded: false };

	// A prior attempt may have committed locally but failed to push (e.g. a transient
	// network error): the remote is still empty while HEAD is already born. Only build
	// the commit when HEAD is genuinely unborn — otherwise re-running `git commit` here
	// dies with "nothing to commit" and strands the local commit unpushed forever. When
	// HEAD already has a commit, fall straight through to (re)pushing it.
	const born = await executor.exec(['rev-parse', '--verify', '--quiet', 'HEAD'], {
		cwd,
		timeout: 30_000,
	});
	if (born.exitCode !== 0) {
		// Commit on `main` so the pushed default matches GitHub's default for a fresh repo.
		// `symbolic-ref` works on an unborn HEAD and is a no-op when HEAD is already `main`.
		const sym = await executor.exec(['symbolic-ref', 'HEAD', 'refs/heads/main'], {
			cwd,
			timeout: 30_000,
		});
		if (sym.exitCode !== 0) return { seeded: false, error: formatGitError(sym.stderr) };

		try {
			if (!(await repo.files.exists('README.md'))) {
				await repo.files.write('README.md', initialReadmeContent(repoIdentifier));
			}
		} catch (e) {
			return { seeded: false, error: e instanceof Error ? e.message : String(e) };
		}

		const add = await executor.exec(['add', '-A'], { cwd, timeout: 30_000 });
		if (add.exitCode !== 0) return { seeded: false, error: formatGitError(add.stderr) };

		// Unsigned bootstrap commit — see the docstring.
		const commit = await executor.exec(
			['-c', 'commit.gpgsign=false', 'commit', '-m', 'Initial commit'],
			{ cwd, timeout: 30_000 },
		);
		if (commit.exitCode !== 0) return { seeded: false, error: formatGitError(commit.stderr) };
	}

	const push = await executor.exec(['push', '-u', 'origin', 'HEAD:main'], {
		cwd,
		needsSsh,
		timeout: 120_000,
	});
	if (push.exitCode !== 0) return { seeded: false, error: formatGitError(push.stderr) };

	return { seeded: true };
}

export async function fetchRepo(
	executor: GitExecutor,
	repo: RepoLoc,
): Promise<{ success: boolean; error?: string }> {
	// Fetch `origin` by name, not `--all`: with no remotes configured (a stray
	// `git init` in the reserved directory) `--all` exits 0 having fetched
	// nothing, and the broken clone reads as "up to date". Naming origin makes
	// that state fail loudly instead.
	const { exitCode, stderr } = await executor.exec(['fetch', '--prune', 'origin'], {
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
	if (upd.exitCode !== 0) {
		return `could not fast-forward ${def}: ${formatGitError(upd.stderr)}`;
	}

	// A clone populated by fetch alone (adopted in place, or one whose initial
	// checkout never completed) has an unborn HEAD: the local default ref now
	// exists, but HEAD still points at a branch with no commit, and `git worktree
	// add` reads HEAD and dies with "Failed to resolve HEAD as a valid ref" — even
	// when handed an explicit commit-ish. Point HEAD at the freshly-materialised
	// default branch (ref only, working tree left untouched) so worktree prep can
	// proceed and the stale clone self-heals.
	const headBorn = await executor.exec(['rev-parse', '--verify', '--quiet', 'HEAD'], {
		cwd,
		timeout: 30_000,
	});
	if (headBorn.exitCode !== 0) {
		const sym = await executor.exec(['symbolic-ref', 'HEAD', local], { cwd, timeout: 30_000 });
		if (sym.exitCode !== 0) return `could not set HEAD to ${def}: ${formatGitError(sym.stderr)}`;
	}
	return undefined;
}

/**
 * Catches a task worktree up to the freshly-fetched `origin/<default>` so a
 * resumed run starts from current trunk instead of forcing the agent to merge by
 * hand. Fast-forwards when the branch carries no commits of its own; otherwise
 * records a merge commit (which needs a git identity — supply it on the
 * executor's env, e.g. `ContainerGitExecutor.forPrep`'s `extraEnv`). A brand-new
 * branch already based on `origin/<default>` is a no-op.
 *
 * Safe by construction — never throws, every failure is a non-fatal warning:
 * - returns early when no default branch resolves (empty remote) or when
 *   `origin/<default>` is already an ancestor of HEAD (nothing to catch up);
 * - skips a worktree with uncommitted/untracked changes, which a merge could
 *   clobber, and warns instead;
 * - on a conflicting (or otherwise failing) merge, runs `merge --abort` so the
 *   branch is left exactly where the agent left it, and warns so the agent
 *   reconciles by hand.
 */
export async function mergeDefaultIntoWorktree(
	executor: GitExecutor,
	repo: RepoLoc,
	wt: WorktreeLoc,
): Promise<{ merged: boolean; warning?: string }> {
	const def = await getRemoteDefaultBranch(executor, repo);
	if (!def) return { merged: false };
	const cwd = wt.containerPath;

	// Already contains origin/<default>: nothing to catch up. Exit 0 = ancestor
	// (covers a brand-new branch just based on the advanced trunk); 1 = behind, so
	// merge; anything else (e.g. 128 unresolvable rev) is an error — skip + warn.
	const ancestor = await executor.exec(['merge-base', '--is-ancestor', `origin/${def}`, 'HEAD'], {
		cwd,
		timeout: 30_000,
	});
	if (ancestor.exitCode === 0) return { merged: false };
	if (ancestor.exitCode !== 1) {
		return {
			merged: false,
			warning: `could not compare with origin/${def}; skipping catch-up merge`,
		};
	}

	// A merge refuses-or-clobbers against a dirty tree; leave the agent's
	// uncommitted work untouched and let it reconcile.
	const status = await executor.exec(['status', '--porcelain'], { cwd, timeout: 30_000 });
	if (status.exitCode === 0 && status.stdout.trim().length > 0) {
		return {
			merged: false,
			warning: `worktree has uncommitted changes; skipping catch-up merge of origin/${def}`,
		};
	}

	const merge = await executor.exec(['merge', '--no-edit', `origin/${def}`], {
		cwd,
		timeout: 120_000,
	});
	if (merge.exitCode === 0) return { merged: true };

	// Conflict or other failure: undo the half-applied merge so the branch is
	// exactly where the agent left it (best-effort — proceed regardless).
	await executor.exec(['merge', '--abort'], { cwd, timeout: 30_000 });
	return {
		merged: false,
		warning: `could not merge origin/${def}: ${formatGitError(merge.stderr)}`,
	};
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

export interface WorktreeListEntry {
	path: string;
	branch?: string;
}

/**
 * Parses `git worktree list --porcelain` into `{ path, branch? }` entries. The
 * main worktree (the clone itself) is always index 0; linked task worktrees
 * follow. `branch` is the full ref (`refs/heads/<name>`) or absent when the
 * worktree is detached.
 */
export async function listWorktrees(
	executor: GitExecutor,
	repo: RepoLoc,
): Promise<WorktreeListEntry[]> {
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
 * it fall back to HEAD — and when HEAD is unborn too (nothing to base a worktree
 * on) it fails with an actionable error rather than git's opaque one.
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
		if (def) {
			args = ['worktree', 'add', '-b', branchName, wt.containerPath, `origin/${def}`];
		} else {
			// No remote default branch resolves (an empty remote). Basing the new
			// branch on HEAD only works when HEAD points at a commit — an unborn HEAD
			// (a clone of an empty repo, or a stray `git init`) makes git (< 2.42) die
			// with the opaque "failed to resolve HEAD as a valid ref", so surface the
			// actionable story instead.
			const head = await executor.exec(['rev-parse', '--verify', '--quiet', 'HEAD'], {
				cwd,
				timeout: 30_000,
			});
			if (head.exitCode !== 0) {
				return {
					success: false,
					created: false,
					error:
						'clone is empty (no commits fetched) — the fetch above failed, or the remote genuinely has no commits; fix connectivity or push an initial commit, then retry',
				};
			}
			args = ['worktree', 'add', '-b', branchName, wt.containerPath];
		}
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
	if (await wt.files.exists('.git')) {
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
		// Rooted at the worktree, so '.' is the worktree itself.
		await wt.files.removeDir('.');
		await pruneWorktrees(executor, repo);
	}

	return addTaskWorktree(executor, repo, wt, branchName);
}

const WORKTREE_PREP_RETRIES = 3;
const WORKTREE_PREP_DELAY_MS = 250;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A worktree-prep git failure that looks like transient bind-mount propagation
 * lag — the freshly-created worktree parent not yet visible in the container's
 * mount namespace — rather than a genuine git error. Right after a container
 * reprovision on macOS Docker Desktop the first `git worktree add` can fail with
 * `could not open '.../.git' for writing: No such file or directory`; a retry a
 * beat later succeeds. Deliberately narrow: real failures (`not a git
 * repository`, merge/auth errors, and Hezo's own `not cloned` marker) fall
 * through so they still fail fast and are never masked.
 */
export function isTransientMountError(error: string | undefined): boolean {
	if (!error) return false;
	const e = error.toLowerCase();
	return (
		e.includes('no such file or directory') ||
		(e.includes('could not open') && e.includes('for writing')) ||
		e.includes('enoent')
	);
}

/**
 * {@link ensureTaskWorktree} wrapped in a bounded retry for the transient
 * mount-propagation ENOENT above. On a transient failure it waits, invokes
 * `onRetry` (the caller re-asserts the worktree parent is visible in-container
 * and emits a run-log breadcrumb), then retries. A non-transient failure returns
 * immediately (fail fast); a transient that never clears returns the original
 * error after the cap (surfaced, not swallowed).
 */
export async function ensureTaskWorktreeWithRetry(
	executor: GitExecutor,
	repo: RepoLoc,
	wt: WorktreeLoc,
	branchName: string,
	onRetry: () => Promise<void>,
	opts: { retries?: number; delayMs?: number } = {},
): Promise<{ success: boolean; created: boolean; error?: string }> {
	const retries = opts.retries ?? WORKTREE_PREP_RETRIES;
	const gap = opts.delayMs ?? WORKTREE_PREP_DELAY_MS;
	let result = await ensureTaskWorktree(executor, repo, wt, branchName);
	for (
		let attempt = 1;
		attempt < retries && !result.success && isTransientMountError(result.error);
		attempt++
	) {
		await sleep(gap);
		await onRetry();
		result = await ensureTaskWorktree(executor, repo, wt, branchName);
	}
	return result;
}

export async function pruneWorktrees(executor: GitExecutor, repo: RepoLoc): Promise<void> {
	await executor.exec(['worktree', 'prune', '--expire', 'now'], {
		cwd: repo.containerPath,
		timeout: 30_000,
	});
}

/**
 * Force-removes a single linked worktree by its path — clears both the checked-out
 * tree and git's `.git/worktrees/<name>` admin entry. Double `--force` removes it even
 * when the worktree is dirty or locked (the caller has already established the tree is
 * safe to discard, e.g. it belongs to a closed task). The branch ref survives, so
 * committed work pushed to `hezo/<identifier>` is never lost.
 */
export async function removeWorktree(
	executor: GitExecutor,
	repo: RepoLoc,
	worktreeContainerPath: string,
): Promise<void> {
	await executor.exec(['worktree', 'remove', '--force', '--force', worktreeContainerPath], {
		cwd: repo.containerPath,
		timeout: 30_000,
	});
}

/**
 * Sweeps the per-task worktrees under `worktreesRootContainer` (the container-side
 * `/worktrees` root), force-removing every one whose task identifier satisfies
 * `shouldRemove`, then prunes any dangling admin metadata. The identifier is the first
 * path segment under the root (`/worktrees/<identifier>/<repo>`), matching the layout the
 * runner creates and the git-state endpoint reads. Returns the identifiers removed. Used
 * by the admin "Prune worktrees" action to clear worktrees of closed/orphaned tasks; the
 * main worktree (the clone under `/workspace`) never sits under the worktrees root, so it
 * is inherently skipped.
 *
 * `limit` bounds one pass. The admin action leaves it unset and sweeps everything; the
 * automatic per-run sweep caps it, so a container carrying a long backlog of stale
 * worktrees pays a bounded cost per run instead of stalling one run to clear all of them.
 * Callers that care whether more remain compare `removed.length` against the cap.
 */
export async function removeWorktreesWhere(
	executor: GitExecutor,
	repo: RepoLoc,
	worktreesRootContainer: string,
	shouldRemove: (taskIdentifier: string) => boolean,
	limit?: number,
): Promise<string[]> {
	const prefix = `${worktreesRootContainer}/`;
	const entries = await listWorktrees(executor, repo);
	const removed: string[] = [];
	for (const entry of entries) {
		if (limit !== undefined && removed.length >= limit) break;
		if (!entry.path.startsWith(prefix)) continue;
		const taskIdentifier = entry.path.slice(prefix.length).split('/')[0];
		if (!taskIdentifier || !shouldRemove(taskIdentifier)) continue;
		await removeWorktree(executor, repo, entry.path);
		removed.push(taskIdentifier);
	}
	await pruneWorktrees(executor, repo);
	return removed;
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
	if (!(await wt.files.exists('.git'))) return null;
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
	if (!(await wt.files.exists('.git'))) return false;
	const status = await executor.exec(['status', '--porcelain'], {
		cwd: wt.containerPath,
		timeout: 10_000,
	});
	if (status.exitCode === 0 && status.stdout.trim().length > 0) return true;
	const headAfter = await getWorktreeHead(executor, wt);
	return headAfter !== null && headBefore !== null && headAfter !== headBefore;
}

/**
 * A clone's local git state for the admin git-state panel. Read **without
 * touching the network**: `ahead`/`behind` compare HEAD against the last-fetched
 * `origin/<default>` tracking ref, so they reflect the most recent `git fetch`,
 * not live origin. `cloned:false` means the on-disk clone has no `.git` yet (repo
 * setup still pending or failed).
 */
export interface CloneState {
	cloned: boolean;
	defaultBranch: string | null;
	headBranch: string | null;
	head: string | null;
	dirty: boolean;
	ahead: number | null;
	behind: number | null;
}

export async function getCloneState(executor: GitExecutor, repo: RepoLoc): Promise<CloneState> {
	if (!(await repo.files.exists('.git'))) {
		return {
			cloned: false,
			defaultBranch: null,
			headBranch: null,
			head: null,
			dirty: false,
			ahead: null,
			behind: null,
		};
	}
	const cwd = repo.containerPath;
	const defaultBranch = await getRemoteDefaultBranch(executor, repo);

	const headBranchRes = await executor.exec(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
		cwd,
		timeout: 10_000,
	});
	const headBranch = headBranchRes.exitCode === 0 ? headBranchRes.stdout.trim() || null : null;

	const headRes = await executor.exec(['rev-parse', '--verify', '--quiet', 'HEAD'], {
		cwd,
		timeout: 10_000,
	});
	const head = headRes.exitCode === 0 ? headRes.stdout.trim() || null : null;

	const statusRes = await executor.exec(['status', '--porcelain'], { cwd, timeout: 10_000 });
	const dirty = statusRes.exitCode === 0 && statusRes.stdout.trim().length > 0;

	let ahead: number | null = null;
	let behind: number | null = null;
	if (defaultBranch && head) {
		const remoteRef = `refs/remotes/origin/${defaultBranch}`;
		const remoteExists = await executor.exec(['rev-parse', '--verify', '--quiet', remoteRef], {
			cwd,
			timeout: 10_000,
		});
		if (remoteExists.exitCode === 0) {
			// left = commits only on origin/<def> (behind), right = only on HEAD (ahead).
			const counts = await executor.exec(
				['rev-list', '--left-right', '--count', `${remoteRef}...HEAD`],
				{ cwd, timeout: 10_000 },
			);
			if (counts.exitCode === 0) {
				const [left, right] = counts.stdout.trim().split(/\s+/);
				const b = Number.parseInt(left ?? '', 10);
				const a = Number.parseInt(right ?? '', 10);
				behind = Number.isNaN(b) ? null : b;
				ahead = Number.isNaN(a) ? null : a;
			}
		}
	}

	return { cloned: true, defaultBranch, headBranch, head, dirty, ahead, behind };
}

/**
 * A task worktree's live state for the git-state panel: its current commit and
 * whether it has uncommitted/untracked changes. `worktreeHasChanges(…, null)`
 * reduces to "`git status --porcelain` non-empty".
 */
export async function getWorktreeState(
	executor: GitExecutor,
	wt: WorktreeLoc,
): Promise<{ head: string | null; dirty: boolean }> {
	const head = await getWorktreeHead(executor, wt);
	const dirty = await worktreeHasChanges(executor, wt, null);
	return { head, dirty };
}

/**
 * Recovers a wedged clone to a syncable state: discards all uncommitted and
 * untracked changes and puts the local default branch back on the (last-fetched)
 * remote tip. This is the escape hatch for the "could not fast-forward <default>:
 * your local changes would be overwritten" state that silently stops periodic
 * sync. A best-effort `git fetch` runs first so the reset lands on the latest
 * origin; a fetch failure is non-fatal (returned as `warning`) so a transient
 * network fault never blocks local recovery. Untracked files are removed with
 * `clean -fd` — no `-x`, so gitignored build artifacts (e.g. `node_modules`) are
 * kept and the next run needn't rebuild them. Committed work already pushed to
 * the remote is unaffected.
 */
export async function resetCloneToOrigin(
	executor: GitExecutor,
	repo: RepoLoc,
): Promise<{ success: boolean; error?: string; warning?: string }> {
	const cwd = repo.containerPath;

	let warning: string | undefined;
	const fetched = await fetchRepo(executor, repo);
	if (!fetched.success) {
		warning = `fetch failed, reset to last-known origin: ${fetched.error ?? 'unknown error'}`;
	}

	const def = await getRemoteDefaultBranch(executor, repo);
	if (!def) {
		return { success: false, error: 'no default branch resolved (empty remote?)', warning };
	}

	// getRemoteDefaultBranch only returns a name whose origin tracking ref exists,
	// so this normally resolves; fall back to the local branch defensively.
	const remoteRef = `refs/remotes/origin/${def}`;
	const remoteExists = await executor.exec(['rev-parse', '--verify', '--quiet', remoteRef], {
		cwd,
		timeout: 10_000,
	});
	const target = remoteExists.exitCode === 0 ? remoteRef : def;

	// Force onto the default branch: reattaches a detached HEAD and abandons any
	// unrelated branch a human may have left checked out in the clone. `-f`
	// discards conflicting working-tree changes so the switch can't be blocked.
	const checkout = await executor.exec(['checkout', '-f', def], { cwd, timeout: 30_000 });
	if (checkout.exitCode !== 0) {
		return { success: false, error: formatGitError(checkout.stderr), warning };
	}

	const reset = await executor.exec(['reset', '--hard', target], { cwd, timeout: 30_000 });
	if (reset.exitCode !== 0) {
		return { success: false, error: formatGitError(reset.stderr), warning };
	}

	const clean = await executor.exec(['clean', '-fd'], { cwd, timeout: 30_000 });
	if (clean.exitCode !== 0) {
		return { success: false, error: formatGitError(clean.stderr), warning };
	}

	return { success: true, warning };
}

/**
 * Filename, inside a clone's git dir, that {@link POST_COMMIT_PUSH_HOOK} appends failed
 * auto-pushes to. Read back by {@link readPushErrors} at run end.
 */
export const PUSH_ERROR_LOG_NAME = 'hezo-push-errors.log';

/**
 * `post-commit` hook installed into every clone so committed work survives an aborted
 * or timed-out run. The per-task worktree is ephemeral and the run's hard time limit
 * discards it on abort, so a commit that only lives in the worktree is lost; pushing
 * on every commit means committed work always reaches the remote.
 *
 * Non-fatal but never silent. Git ignores post-commit's exit status and a failed push
 * must never break the agent's commit — but it must not look like a successful one
 * either. A denied push (the connected account lacks write on this repo, a protected
 * branch, a lost SSH agent) used to be discarded to `/dev/null`, so the agent saw the
 * same output as a clean push and was left to guess why its work never landed. The
 * failure is now reported twice: one line on the commit's own stderr, where the agent
 * sees it immediately, and the full git error appended to {@link PUSH_ERROR_LOG_NAME}
 * in the git dir, which the runner surfaces into the run log at run end for the human.
 *
 * The rest of the shape:
 * - `[ -S "$SSH_AUTH_SOCK" ]` — only push when a live SSH agent socket exists. That
 *   holds during the agent's own bridged run (where its commits happen) but not during
 *   Hezo's bare prep git ops, so the prep-time catch-up merge commit
 *   ({@link mergeDefaultIntoWorktree}) is skipped instead of attempting a doomed,
 *   unauthenticated push.
 * - `git push origin HEAD` — task branches (`hezo/<task>`) have no upstream; HEAD
 *   pushes to the same-named remote branch, always a fast-forward on the single-writer
 *   per-task branch.
 * - `--no-verify` — this is a durability checkpoint, not a reviewed push, so it skips
 *   any pre-push test/lint hook; a WIP commit whose tests are still red must reach the
 *   remote all the same.
 * - `exit 0` unconditionally — reporting a failure is not the same as failing the commit.
 */
export const POST_COMMIT_PUSH_HOOK = `#!/bin/sh
# Hezo durability hook — installed by ensurePushHook(); do not edit in place.
# Push each commit to origin immediately so committed work survives an aborted or
# timed-out run (the per-task worktree is ephemeral). Non-fatal: never break a commit,
# but never hide a failed push either — a denied push must not look like a clean one.
[ -S "$SSH_AUTH_SOCK" ] || exit 0
git remote get-url origin >/dev/null 2>&1 || exit 0

hezo_push_out=$(git push --no-verify origin HEAD 2>&1) && exit 0

hezo_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)
hezo_remote=$(git remote get-url origin 2>/dev/null || echo origin)
hezo_log="$(git rev-parse --git-common-dir 2>/dev/null || echo .git)/${PUSH_ERROR_LOG_NAME}"
{
  echo "=== auto-push failed: $hezo_remote ($hezo_branch)"
  echo "$hezo_push_out"
} >>"$hezo_log" 2>/dev/null || true
echo "hezo: auto-push to $hezo_remote ($hezo_branch) failed — this commit is local only." >&2
echo "$hezo_push_out" | head -n 5 >&2
exit 0
`;

/**
 * Install (or refresh) {@link POST_COMMIT_PUSH_HOOK} in a clone's shared git hooks dir.
 * Idempotent — rewritten on every run so the script stays current. Git resolves
 * `hooks/` from the common git dir, so this one file fires for commits made in any task
 * worktree of the clone. A physical hook file coexists with any repo-provided hooks
 * (unlike a `core.hooksPath` override, which would disable them). Call with the clone's
 * {@link RepoLoc} (whose `.git` is a real directory), never a worktree loc. Best-effort:
 * a filesystem failure is swallowed so it never blocks run prep — the agent's own
 * end-of-run push still lands the work; only the per-commit safeguard is skipped.
 */
export async function ensurePushHook(clone: RepoLoc): Promise<void> {
	try {
		// The seam writes the mode rather than a separate chmod: it creates parent
		// directories and applies the mode on every write, so a refresh over an
		// existing (or umask-narrowed) file is executable either way.
		await clone.files.write(PUSH_HOOK_REL_PATH, POST_COMMIT_PUSH_HOOK, { mode: 0o755 });
	} catch {
		// Non-fatal — see the docstring. Swallowed so run prep never fails on a hook write.
	}
}

const PUSH_HOOK_REL_PATH = '.git/hooks/post-commit';
const pushErrorLogRelPath = `.git/${PUSH_ERROR_LOG_NAME}`;

/**
 * Clear a clone's auto-push error log at run prep, so what {@link readPushErrors}
 * reports at run end belongs to this run and not a previous one. Best-effort.
 */
export async function clearPushErrors(clone: RepoLoc): Promise<void> {
	try {
		await clone.files.remove(pushErrorLogRelPath);
	} catch {
		// Non-fatal — a stale log is worth less than a failed run prep.
	}
}

/**
 * Read back the auto-pushes that failed during this run, so the runner can put them
 * in the run log. Without this a denied push is visible only on the agent's own
 * stderr — which nobody reads once the run is over — and a repo the connected
 * account cannot write to looks indistinguishable from one it can.
 *
 * Returns the trailing `maxLines` lines, or null when nothing failed. Best-effort:
 * an unreadable log reports nothing rather than throwing at run finalize.
 */
export async function readPushErrors(clone: RepoLoc, maxLines = 40): Promise<string | null> {
	try {
		// A missing log rejects, which is the same "nothing failed" answer.
		const text = (await clone.files.read(pushErrorLogRelPath)).trim();
		if (!text) return null;
		const lines = text.split('\n');
		return lines.length > maxLines ? lines.slice(-maxLines).join('\n') : text;
	} catch {
		return null;
	}
}

/**
 * Remotes whose refs mean "this commit reached the user's git host".
 *
 * Just `origin`, and the durability backstop deliberately did **not** join it.
 * {@link RECOVERY_REMOTE} means Hezo holds a copy, which is enough to stop
 * destroying the container but is not the same as the work being on the remote
 * the human pushes to - a run whose every push was denied must keep reporting
 * that, however well the copy is kept.
 */
export const DURABLE_REMOTES = ['origin'] as const;

/**
 * Commits on a clone's task branch that reached none of {@link DURABLE_REMOTES}.
 *
 * **This is a ref comparison, deliberately, and not a read of
 * {@link PUSH_ERROR_LOG_NAME}.** The log is append-only within a run and cleared at
 * prep, so a push that failed at commit 3 and succeeded at commit 5 leaves a
 * non-empty log with nothing actually unpushed - reporting off it would fail a run
 * whose work is safely on the remote. The authoritative question is whether the
 * local `hezo/<task>` tip is reachable from a remote-tracking ref, which this asks
 * directly.
 *
 * `git push` updates the corresponding `refs/remotes/origin/*` ref on success, and
 * run prep fetches before the agent starts, so the tracking refs are a faithful
 * local record of what the remote holds - no network call is needed or made.
 *
 * `--not --remotes=<name>` excludes everything reachable from that remote's
 * tracking refs, which answers all four shapes uniformly: pushed and current (0),
 * pushed but behind (the delta), never pushed but already merged into the default
 * branch (0, correctly - the commits are on the remote), and never pushed at all
 * (the whole branch).
 *
 * Returns 0 for a definite all-clear (including "the branch was never created", so
 * the agent committed nothing), and **null when the question could not be answered**
 * - the clone is gone or git failed. Null is not 0: a diagnostic that could not run
 * must neither fail a run nor clear a pin.
 */
export async function countUnpushedCommits(
	executor: GitExecutor,
	repo: RepoLoc,
	branch: string,
	remotes: readonly string[] = DURABLE_REMOTES,
): Promise<number | null> {
	if (!(await repo.files.exists('.git'))) return null;
	const localRef = `refs/heads/${branch}`;
	const exists = await executor.exec(['rev-parse', '--verify', '--quiet', localRef], {
		cwd: repo.containerPath,
		timeout: 10_000,
	});
	// No branch is a definite absence of unpushed work, not an unanswered question:
	// the agent committed nothing on this task's branch in this clone.
	if (exists.exitCode !== 0) return 0;

	const { exitCode, stdout } = await executor.exec(
		['rev-list', '--count', localRef, '--not', ...remotes.map((r) => `--remotes=${r}`)],
		{ cwd: repo.containerPath, timeout: 30_000 },
	);
	if (exitCode !== 0) return null;
	const count = Number.parseInt(stdout.trim(), 10);
	return Number.isFinite(count) ? count : null;
}

/** A clone left holding commits that reached no durable remote. */
export interface UnpushedWork {
	repo: RepoLoc;
	branch: string;
	commits: number;
}

export interface UnpushedWorkScan {
	/** Clones holding commits that reached no durable remote. */
	work: UnpushedWork[];
	/**
	 * True when every clone answered. False when at least one could not be read, in
	 * which case an empty `work` is "nothing found", not an all-clear - so it may
	 * not be used to release a container pinned by an earlier run.
	 */
	complete: boolean;
}

/**
 * The clones a run is about to leave behind with commits that exist nowhere but
 * this container.
 *
 * With one container per project this was survivable: the next run hit the same
 * `.git` and the ref was still there. Once a project has several containers it is
 * not - run 1 commits into container A, its push is denied, run 2 lands on
 * container B and fetches from a remote that never received the commit, and A is
 * destroyed when it goes idle. Nothing fails at pool size 1, which is why no
 * existing test caught it.
 */
export async function findUnpushedWork(
	executor: GitExecutor,
	clones: RepoLoc[],
	branch: string,
): Promise<UnpushedWorkScan> {
	const work: UnpushedWork[] = [];
	let complete = true;
	for (const repo of clones) {
		const commits = await countUnpushedCommits(executor, repo, branch);
		if (commits === null) complete = false;
		else if (commits > 0) work.push({ repo, branch, commits });
	}
	return { work, complete };
}

/**
 * One line per clone, for the run log and the run row's error. Names the branch and
 * the clone so the human knows exactly which container holds the work and what to
 * fetch out of it.
 */
export function describeUnpushedWork(work: UnpushedWork[]): string {
	const parts = work.map(
		(w) =>
			`${w.commits} commit${w.commits === 1 ? '' : 's'} on ${w.branch} in ${w.repo.containerPath}`,
	);
	return `run ended with committed work that reached no remote (${parts.join('; ')}) — the commits exist only in this container`;
}

/**
 * Filename, inside a clone's git dir, of the recovery bundle a run builds when its
 * commits reached no remote - and that a later run on a *different* container
 * restores from.
 *
 * In the git dir deliberately, beside {@link PUSH_ERROR_LOG_NAME}, for two
 * reasons. It is real local disk: `git bundle create` **seeks while writing** and
 * dies (`pack-objects died`) against an object-store-backed mount, so the bundle
 * has to be built locally and moved as a finished file. And the git dir is
 * already owned by the run user, so the unelevated git that builds it can write
 * there without a chown dance.
 */
export const RECOVERY_BUNDLE_NAME = 'hezo-recovery.bundle';

/**
 * The bundle's path relative to the clone root, which is what
 * {@link SandboxFiles} rooted at the clone addresses it by.
 *
 * Uses the *common* git dir literally rather than asking git for it: a clone's
 * `.git` is a real directory (worktrees are what get a file), which
 * {@link ensurePushHook} already relies on.
 */
export const RECOVERY_BUNDLE_REL_PATH = `.git/${RECOVERY_BUNDLE_NAME}`;

/**
 * Remote-tracking namespace restored bundle refs land in.
 *
 * Deliberately **not** in {@link DURABLE_REMOTES}: a recovered ref means Hezo
 * holds a copy, not that the user's git host does. Counting it as durable would
 * make a run whose pushes were all denied report success the moment its work was
 * vaulted, which is the opposite of what the human needs to see.
 */
export const RECOVERY_REMOTE = 'hezo-recovery';

/**
 * Pack a branch's undelivered commits into a bundle inside the container.
 *
 * `--not --remotes=<durable>` makes this a **delta**: the bundle carries only what
 * no durable remote already has, recording the remote tips as prerequisites. That
 * is what keeps it kilobytes for an ordinary task rather than a copy of the whole
 * history, and it is why a container restoring it must have fetched origin first
 * (run prep always has, before it restores). A clone with no remote at all has no
 * prerequisites to exclude, so its bundle is the entire branch - correct, and the
 * case the vault's size cap exists for.
 *
 * Never throws: this runs at run finalize, where the run is already being failed
 * for the unpushed work, and a broken bundle must not mask that.
 */
export async function createRecoveryBundle(
	executor: GitExecutor,
	repo: RepoLoc,
	branch: string,
	remotes: readonly string[] = DURABLE_REMOTES,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const res = await executor.exec(
		[
			'bundle',
			'create',
			RECOVERY_BUNDLE_REL_PATH,
			`refs/heads/${branch}`,
			'--not',
			...remotes.map((r) => `--remotes=${r}`),
		],
		{ cwd: repo.containerPath, timeout: 120_000 },
	);
	if (res.exitCode !== 0) {
		return { ok: false, error: formatGitError(res.stderr) || 'git bundle create failed' };
	}
	return { ok: true };
}

/**
 * Fetch a restored bundle's commits into a clone.
 *
 * The refs land under `refs/remotes/{@link RECOVERY_REMOTE}/` rather than on the
 * branch itself. That is the conservative half of recovery: the commits become
 * *present* in this clone - so nothing is lost when the container that held them
 * is destroyed - without silently moving a branch the agent is about to work on.
 *
 * `git bundle` verifies its own prerequisites, so a bundle whose base commits this
 * clone lacks fails here rather than half-applying.
 *
 * Non-throwing for the same reason as {@link createRecoveryBundle}: a failed
 * recovery is reported into the run log and the source container stays pinned,
 * never an exception out of run prep.
 */
export async function fetchRecoveryBundle(
	executor: GitExecutor,
	repo: RepoLoc,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const res = await executor.exec(
		[
			'fetch',
			'--no-write-fetch-head',
			RECOVERY_BUNDLE_REL_PATH,
			`+refs/heads/*:refs/remotes/${RECOVERY_REMOTE}/*`,
		],
		{ cwd: repo.containerPath, timeout: 120_000 },
	);
	if (res.exitCode !== 0) {
		return { ok: false, error: formatGitError(res.stderr) || 'git fetch from bundle failed' };
	}
	return { ok: true };
}

/**
 * Merge recovered commits into the task branch, so the agent's worktree actually
 * contains the work an earlier container committed.
 *
 * Separate from {@link fetchRecoveryBundle} because the two answer different
 * questions: fetching is about *not losing* the commits, merging is about *using*
 * them. Fast-forward only - the recovered tip descends from what this clone has
 * whenever the earlier run was the only writer, which the one-active-run-per-task
 * rule guarantees. If it is not a fast-forward, something genuinely diverged and
 * the agent should reconcile it deliberately rather than have a merge commit
 * appear from a background recovery.
 */
export async function fastForwardFromRecovery(
	executor: GitExecutor,
	worktree: WorktreeLoc,
	branch: string,
): Promise<{ merged: boolean; warning?: string }> {
	const ref = `refs/remotes/${RECOVERY_REMOTE}/${branch}`;
	const exists = await executor.exec(['rev-parse', '--verify', '--quiet', ref], {
		cwd: worktree.containerPath,
		timeout: 10_000,
	});
	if (exists.exitCode !== 0) return { merged: false };

	const res = await executor.exec(['merge', '--ff-only', ref], {
		cwd: worktree.containerPath,
		timeout: 60_000,
	});
	if (res.exitCode !== 0) {
		return {
			merged: false,
			warning:
				`recovered commits for ${branch} could not be fast-forwarded into the worktree ` +
				`(${formatGitError(res.stderr) || 'merge failed'}) — they are present as ${ref}`,
		};
	}
	return { merged: !res.stdout.includes('Already up to date') };
}
