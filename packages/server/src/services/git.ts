import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
				resolve({
					exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
					stdout: stdout?.toString() ?? '',
					stderr: stderr?.toString() ?? '',
				});
			},
		);
	});
}

const SSH_HOSTS: Record<RepoHostType, string> = {
	[RepoHostType.GitHub]: 'git@github.com',
};

export function buildGitSshUrl(hostType: RepoHostType, repoIdentifier: string): string {
	const host = SSH_HOSTS[hostType];
	if (!host) throw new Error(`Unsupported repo host type: ${hostType}`);
	return `${host}:${repoIdentifier}.git`;
}

function sshEnvWithKey(sshPrivateKeyPem: string): {
	env: Record<string, string>;
	cleanup: () => void;
} {
	const keyFile = join(tmpdir(), `hezo-ssh-${randomBytes(8).toString('hex')}`);
	writeFileSync(keyFile, sshPrivateKeyPem, { mode: 0o600 });
	chmodSync(keyFile, 0o600);
	return {
		env: {
			GIT_SSH_COMMAND: `ssh -i ${keyFile} -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10`,
		},
		cleanup: () => {
			try {
				unlinkSync(keyFile);
			} catch {
				// Best effort
			}
		},
	};
}

export async function cloneRepo(
	repoIdentifier: string,
	targetDir: string,
	sshPrivateKeyPem: string,
	hostType: RepoHostType = RepoHostType.GitHub,
): Promise<{ success: boolean; error?: string }> {
	const sshUrl = buildGitSshUrl(hostType, repoIdentifier);
	const { env, cleanup } = sshEnvWithKey(sshPrivateKeyPem);
	try {
		const { exitCode, stderr } = await spawn('git', ['clone', sshUrl, targetDir], { env });
		if (exitCode !== 0) return { success: false, error: stderr.trim() };
		return { success: true };
	} finally {
		cleanup();
	}
}

export async function createWorktree(
	repoDir: string,
	worktreePath: string,
	branchName: string,
): Promise<{ success: boolean; error?: string }> {
	const { exitCode, stderr } = await spawn(
		'git',
		['worktree', 'add', '-b', branchName, worktreePath],
		{ cwd: repoDir },
	);

	if (exitCode !== 0) return { success: false, error: stderr.trim() };
	return { success: true };
}

export async function fetchRepo(
	repoDir: string,
	sshPrivateKeyPem: string,
): Promise<{ success: boolean; error?: string }> {
	const { env, cleanup } = sshEnvWithKey(sshPrivateKeyPem);
	try {
		const { exitCode, stderr } = await spawn('git', ['fetch', '--all', '--prune'], {
			cwd: repoDir,
			env,
		});
		if (exitCode !== 0) return { success: false, error: stderr.trim() };
		return { success: true };
	} finally {
		cleanup();
	}
}

export async function ensureIssueWorktree(
	repoDir: string,
	worktreePath: string,
	branchName: string,
): Promise<{ success: boolean; created: boolean; error?: string }> {
	if (existsSync(join(worktreePath, '.git'))) {
		const ff = await spawn('git', ['merge', '--ff-only', `origin/${branchName}`], {
			cwd: worktreePath,
		});
		if (ff.exitCode !== 0 && !ff.stderr.toLowerCase().includes("couldn't find remote ref")) {
			return { success: true, created: false, error: ff.stderr.trim() };
		}
		return { success: true, created: false };
	}

	const remoteCheck = await spawn('git', ['rev-parse', '--verify', `origin/${branchName}`], {
		cwd: repoDir,
	});

	let result: Awaited<ReturnType<typeof spawn>>;
	if (remoteCheck.exitCode === 0) {
		result = await spawn(
			'git',
			['worktree', 'add', '--track', '-b', branchName, worktreePath, `origin/${branchName}`],
			{ cwd: repoDir },
		);
	} else {
		result = await spawn('git', ['worktree', 'add', '-b', branchName, worktreePath], {
			cwd: repoDir,
		});
	}

	if (result.exitCode !== 0) {
		return { success: false, created: false, error: result.stderr.trim() };
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
