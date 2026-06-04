import { execFile } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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

export async function ensureTaskWorktree(
	repoDir: string,
	worktreePath: string,
	branchName: string,
): Promise<{ success: boolean; created: boolean; error?: string }> {
	if (existsSync(join(worktreePath, '.git'))) {
		// Rewrite the worktree's gitdir links to relative form. Worktrees created
		// before this used absolute host paths, which resolve on the host but not
		// inside the container's bind mounts; relativizing makes them portable.
		await spawn('git', ['worktree', 'repair', '--relative-paths', worktreePath], {
			cwd: repoDir,
			timeout: 30_000,
		});
		const ff = await spawn('git', ['merge', '--ff-only', `origin/${branchName}`], {
			cwd: worktreePath,
			timeout: 30_000,
		});
		if (ff.exitCode !== 0 && !ff.stderr.toLowerCase().includes("couldn't find remote ref")) {
			return { success: true, created: false, error: formatGitError(ff.stderr) };
		}
		return { success: true, created: false };
	}

	const remoteCheck = await spawn('git', ['rev-parse', '--verify', `origin/${branchName}`], {
		cwd: repoDir,
		timeout: 30_000,
	});

	let result: Awaited<ReturnType<typeof spawn>>;
	if (remoteCheck.exitCode === 0) {
		result = await spawn(
			'git',
			[
				'worktree',
				'add',
				'--relative-paths',
				'--track',
				'-b',
				branchName,
				worktreePath,
				`origin/${branchName}`,
			],
			{ cwd: repoDir, timeout: 30_000 },
		);
	} else {
		result = await spawn(
			'git',
			['worktree', 'add', '--relative-paths', '-b', branchName, worktreePath],
			{ cwd: repoDir, timeout: 30_000 },
		);
	}

	if (result.exitCode !== 0) {
		return { success: false, created: false, error: formatGitError(result.stderr) };
	}
	return { success: true, created: true };
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
	await spawn('git', ['worktree', 'prune'], { cwd: repoDir });
}
