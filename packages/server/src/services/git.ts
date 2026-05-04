import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
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

const HTTPS_HOSTS: Record<RepoHostType, string> = {
	[RepoHostType.GitHub]: 'github.com',
};

export function buildGitHttpsUrl(hostType: RepoHostType, repoIdentifier: string): string {
	const host = HTTPS_HOSTS[hostType];
	if (!host) throw new Error(`Unsupported repo host type: ${hostType}`);
	return `https://${host}/${repoIdentifier}.git`;
}

function httpsEnvWithToken(token: string): Record<string, string> {
	return {
		GIT_TERMINAL_PROMPT: '0',
		GIT_ASKPASS: '/bin/echo',
		GIT_HTTP_EXTRAHEADER: `Authorization: bearer ${token}`,
	};
}

export async function cloneRepo(
	repoIdentifier: string,
	targetDir: string,
	accessToken: string,
	hostType: RepoHostType = RepoHostType.GitHub,
): Promise<{ success: boolean; error?: string }> {
	const url = buildGitHttpsUrl(hostType, repoIdentifier);
	const { exitCode, stderr } = await spawn(
		'git',
		[
			'-c',
			`http.${url}.extraHeader=Authorization: bearer ${token(accessToken)}`,
			'clone',
			url,
			targetDir,
		],
		{
			env: httpsEnvWithToken(accessToken),
			timeout: 120_000,
		},
	);
	if (exitCode !== 0)
		return { success: false, error: redactToken(formatGitError(stderr), accessToken) };
	return { success: true };
}

function token(t: string): string {
	return t;
}

function redactToken(text: string, accessToken: string): string {
	if (!accessToken) return text;
	return text.split(accessToken).join('***');
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
	accessToken: string,
): Promise<{ success: boolean; error?: string }> {
	const { exitCode, stderr } = await spawn('git', ['fetch', '--all', '--prune'], {
		cwd: repoDir,
		env: httpsEnvWithToken(accessToken),
		timeout: 60_000,
	});
	if (exitCode !== 0)
		return { success: false, error: redactToken(formatGitError(stderr), accessToken) };
	return { success: true };
}

export async function ensureIssueWorktree(
	repoDir: string,
	worktreePath: string,
	branchName: string,
): Promise<{ success: boolean; created: boolean; error?: string }> {
	if (existsSync(join(worktreePath, '.git'))) {
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
			['worktree', 'add', '--track', '-b', branchName, worktreePath, `origin/${branchName}`],
			{ cwd: repoDir, timeout: 30_000 },
		);
	} else {
		result = await spawn('git', ['worktree', 'add', '-b', branchName, worktreePath], {
			cwd: repoDir,
			timeout: 30_000,
		});
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
