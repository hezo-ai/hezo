import { execFile } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { RepoHostType } from '@hezo/shared';

function spawn(
	cmd: string,
	args: string[],
	opts: { cwd?: string; env?: Record<string, string | undefined>; timeout?: number } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		execFile(
			cmd,
			args,
			{ cwd: opts.cwd, env: { ...process.env, ...opts.env }, timeout: opts.timeout },
			(error, stdout, stderr) => {
				const timedOut = error && 'killed' in error && error.killed;
				resolve({
					exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
					stdout: stdout?.toString() ?? '',
					stderr: timedOut
						? `timed out after ${Math.round((opts.timeout ?? 0) / 1000)}s`
						: (stderr?.toString() ?? ''),
				});
			},
		);
	});
}

function formatGitError(stderr: string): string {
	const trimmed = stderr.trim();
	if (trimmed.startsWith('timed out')) return trimmed;
	return trimmed;
}

const SSH_HOSTS: Record<RepoHostType, string> = {
	[RepoHostType.GitHub]: 'github.com',
};

export function buildGitSshUrl(hostType: RepoHostType, repoIdentifier: string): string {
	const host = SSH_HOSTS[hostType];
	if (!host) throw new Error(`Unsupported repo host type: ${hostType}`);
	return `git@${host}:${repoIdentifier}.git`;
}

/**
 * Pinned public host keys for github.com, sourced from
 * https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints.
 * Used as the `UserKnownHostsFile` for every host-side git op so SSH refuses
 * to connect to anything that doesn't present one of these keys.
 */
const GITHUB_KNOWN_HOSTS = `github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl
github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=
github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=
`;

/**
 * Writes the bundled known_hosts to a stable path under `<dataDir>/ssh/known_hosts`
 * and returns that path. Idempotent — overwrites only if the file is missing
 * or stale, so multiple concurrent callers converge on the same content.
 */
export async function ensureGithubKnownHosts(dataDir: string): Promise<string> {
	const path = join(dataDir, 'ssh', 'known_hosts');
	if (!existsSync(path)) {
		await mkdir(dirname(path), { recursive: true });
		writeFileSync(path, GITHUB_KNOWN_HOSTS, { mode: 0o644 });
	}
	return path;
}

function sshEnv(sshAuthSock: string, knownHostsPath: string): Record<string, string> {
	return {
		GIT_TERMINAL_PROMPT: '0',
		SSH_AUTH_SOCK: sshAuthSock,
		GIT_SSH_COMMAND: `ssh -o UserKnownHostsFile=${knownHostsPath} -o StrictHostKeyChecking=yes -o IdentityAgent=${sshAuthSock} -o IdentitiesOnly=no`,
	};
}

export async function cloneRepo(
	repoIdentifier: string,
	targetDir: string,
	sshAuthSock: string,
	knownHostsPath: string,
	hostType: RepoHostType = RepoHostType.GitHub,
): Promise<{ success: boolean; error?: string }> {
	const url = buildGitSshUrl(hostType, repoIdentifier);
	const { exitCode, stderr } = await spawn('git', ['clone', url, targetDir], {
		env: sshEnv(sshAuthSock, knownHostsPath),
		timeout: 120_000,
	});
	if (exitCode !== 0) return { success: false, error: formatGitError(stderr) };
	return { success: true };
}

export async function fetchRepo(
	repoDir: string,
	sshAuthSock: string,
	knownHostsPath: string,
): Promise<{ success: boolean; error?: string }> {
	const { exitCode, stderr } = await spawn('git', ['fetch', '--all', '--prune'], {
		cwd: repoDir,
		env: sshEnv(sshAuthSock, knownHostsPath),
		timeout: 60_000,
	});
	if (exitCode !== 0) return { success: false, error: formatGitError(stderr) };
	return { success: true };
}

export async function createWorktree(
	repoDir: string,
	worktreePath: string,
	branchName: string,
): Promise<{ success: boolean; error?: string }> {
	const { exitCode, stderr } = await spawn(
		'git',
		['worktree', 'add', '--relative-paths', '-b', branchName, worktreePath],
		{ cwd: repoDir },
	);

	if (exitCode !== 0) return { success: false, error: stderr.trim() };
	return { success: true };
}

/**
 * A linked worktree resolves only when its admin metadata still lives under the
 * clone's `.git/worktrees/<name>`. That entry can be lost — pruned/gc'd when an
 * older absolute-path link no longer resolved inside the container, or the clone
 * recreated — while the worktree tree itself survives on its separate mount,
 * leaving a `.git` file that points nowhere. Confirm the link still resolves to a
 * git dir that exists on disk.
 */
async function isWorktreeHealthy(worktreePath: string): Promise<boolean> {
	const res = await spawn('git', ['-C', worktreePath, 'rev-parse', '--git-dir'], {
		timeout: 30_000,
	});
	if (res.exitCode !== 0) return false;
	const gitDir = res.stdout.trim();
	if (!gitDir) return false;
	const resolved = isAbsolute(gitDir) ? gitDir : join(worktreePath, gitDir);
	return existsSync(resolved);
}

interface WorktreeListEntry {
	path: string;
	branch?: string;
}

async function listWorktrees(repoDir: string): Promise<WorktreeListEntry[]> {
	const res = await spawn('git', ['worktree', 'list', '--porcelain'], {
		cwd: repoDir,
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
 * runs that died mid-task — e.g. a worktree the agent created inside the clone,
 * registered under a container-absolute path that resolves nowhere on the host.
 * Unregisters every holder of the branch: unresolvable registrations are
 * pruned, linked worktrees are force-removed, and a checkout in the main
 * worktree is detached. Committed work survives on the branch ref.
 */
async function releaseBranchFromWorktrees(repoDir: string, branchName: string): Promise<void> {
	await spawn('git', ['worktree', 'prune', '--expire', 'now'], {
		cwd: repoDir,
		timeout: 30_000,
	});

	const entries = await listWorktrees(repoDir);
	const ref = `refs/heads/${branchName}`;
	for (const [i, entry] of entries.entries()) {
		if (entry.branch !== ref) continue;
		if (i === 0) {
			// The main worktree holds the branch; detach HEAD to free it.
			await spawn('git', ['checkout', '--detach'], { cwd: repoDir, timeout: 30_000 });
		} else {
			await spawn('git', ['worktree', 'remove', '--force', '--force', entry.path], {
				cwd: repoDir,
				timeout: 30_000,
			});
		}
	}
}

/**
 * Adds a worktree for the task branch, choosing the checkout source by what
 * already exists: an existing local branch is checked out as-is (preserving its
 * commits — the case when rebuilding a worktree whose metadata was lost), an
 * existing remote branch is tracked, otherwise a new branch is created.
 */
async function addTaskWorktree(
	repoDir: string,
	worktreePath: string,
	branchName: string,
): Promise<{ success: boolean; created: boolean; error?: string }> {
	await releaseBranchFromWorktrees(repoDir, branchName);

	const localBranch = await spawn(
		'git',
		['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`],
		{ cwd: repoDir, timeout: 30_000 },
	);
	const remoteBranch = await spawn('git', ['rev-parse', '--verify', `origin/${branchName}`], {
		cwd: repoDir,
		timeout: 30_000,
	});

	let args: string[];
	if (localBranch.exitCode === 0) {
		args = ['worktree', 'add', '--relative-paths', worktreePath, branchName];
	} else if (remoteBranch.exitCode === 0) {
		args = [
			'worktree',
			'add',
			'--relative-paths',
			'--track',
			'-b',
			branchName,
			worktreePath,
			`origin/${branchName}`,
		];
	} else {
		args = ['worktree', 'add', '--relative-paths', '-b', branchName, worktreePath];
	}

	const result = await spawn('git', args, { cwd: repoDir, timeout: 30_000 });
	if (result.exitCode !== 0) {
		return { success: false, created: false, error: formatGitError(result.stderr) };
	}
	return { success: true, created: true };
}

export async function ensureTaskWorktree(
	repoDir: string,
	worktreePath: string,
	branchName: string,
): Promise<{ success: boolean; created: boolean; error?: string }> {
	if (existsSync(join(worktreePath, '.git'))) {
		// Relativize the worktree's gitdir links. Worktrees created before this used
		// absolute host paths that resolve on the host but not inside the container's
		// bind mounts; repair rewrites them to portable relative form.
		await spawn('git', ['worktree', 'repair', '--relative-paths', worktreePath], {
			cwd: repoDir,
			timeout: 30_000,
		});

		if (await isWorktreeHealthy(worktreePath)) {
			const ff = await spawn('git', ['merge', '--ff-only', `origin/${branchName}`], {
				cwd: worktreePath,
				timeout: 30_000,
			});
			if (ff.exitCode !== 0 && !ff.stderr.toLowerCase().includes("couldn't find remote ref")) {
				return { success: true, created: false, error: formatGitError(ff.stderr) };
			}
			return { success: true, created: false };
		}

		// The tree exists but its git dir no longer resolves and repair can't rebuild
		// a fully-lost admin entry. Discard the stale tree and recreate the worktree
		// from the branch, which still lives in the clone.
		rmSync(worktreePath, { recursive: true, force: true });
		await pruneWorktrees(repoDir);
	}

	return addTaskWorktree(repoDir, worktreePath, branchName);
}

export async function removeWorktree(
	repoDir: string,
	worktreePath: string,
): Promise<{ success: boolean; error?: string }> {
	const { exitCode, stderr } = await spawn('git', ['worktree', 'remove', '--force', worktreePath], {
		cwd: repoDir,
	});

	if (exitCode !== 0) {
		return { success: false, error: stderr.trim() };
	}
	return { success: true };
}

export async function pruneWorktrees(repoDir: string): Promise<void> {
	await spawn('git', ['worktree', 'prune', '--expire', 'now'], { cwd: repoDir });
}

/**
 * Resolve the current commit a worktree points at, or null if the worktree is
 * missing or has no commit (e.g. an unborn branch). Captured before a run so a
 * post-run comparison can tell whether the agent advanced the branch.
 */
export async function getWorktreeHead(worktreePath: string): Promise<string | null> {
	if (!existsSync(join(worktreePath, '.git'))) return null;
	const { exitCode, stdout } = await spawn('git', ['rev-parse', 'HEAD'], {
		cwd: worktreePath,
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
	worktreePath: string,
	headBefore: string | null,
): Promise<boolean> {
	if (!existsSync(join(worktreePath, '.git'))) return false;
	const status = await spawn('git', ['status', '--porcelain'], {
		cwd: worktreePath,
		timeout: 10_000,
	});
	if (status.exitCode === 0 && status.stdout.trim().length > 0) return true;
	const headAfter = await getWorktreeHead(worktreePath);
	return headAfter !== null && headBefore !== null && headAfter !== headBefore;
}
