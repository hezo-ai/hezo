import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

export async function cloneRepo(
	repoIdentifier: string,
	targetDir: string,
	sshPrivateKeyPem: string,
): Promise<{ success: boolean; error?: string }> {
	const sshUrl = `git@github.com:${repoIdentifier}.git`;
	const keyFile = join(tmpdir(), `hezo-ssh-${randomBytes(8).toString('hex')}`);

	try {
		writeFileSync(keyFile, sshPrivateKeyPem, { mode: 0o600 });
		chmodSync(keyFile, 0o600);

		const sshCommand = `ssh -i ${keyFile} -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10`;

		const { exitCode, stderr } = await spawn('git', ['clone', sshUrl, targetDir], {
			env: { GIT_SSH_COMMAND: sshCommand },
		});

		if (exitCode !== 0) {
			return { success: false, error: stderr.trim() };
		}

		return { success: true };
	} finally {
		try {
			unlinkSync(keyFile);
		} catch {
			// Best effort cleanup
		}
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
		{
			cwd: repoDir,
		},
	);

	if (exitCode !== 0) {
		return { success: false, error: stderr.trim() };
	}
	return { success: true };
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
