import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { repoNameFromIdentifier } from '@hezo/shared';
import type { MasterKeyManager } from '../crypto/master-key';
import { logger } from '../logger';
import { cloneRepo, ensureGithubKnownHosts, initRepoInPlace } from './git';
import { withHostAgentSocket } from './ssh-agent/host';
import type { SshAgentServer } from './ssh-agent/server';
import { getWorkspacePath, getWorktreesPath } from './workspace';

const log = logger.child('repo-sync');

export type LogEmitter = (stream: 'stdout' | 'stderr', text: string) => void;

/** Repos keyed by name — the workspace directory each clone lives in. */
export interface RepoSyncResult {
	cloned: string[];
	skipped: string[];
	failed: Array<{ name: string; error: string }>;
}

export interface ProjectIdentity {
	id: string;
	team_id: string;
}

export async function ensureProjectRepos(
	db: PGlite,
	_masterKeyManager: MasterKeyManager,
	project: ProjectIdentity,
	dataDir: string,
	sshAgentServer: SshAgentServer | null | undefined,
	logEmit?: LogEmitter,
): Promise<RepoSyncResult> {
	const result: RepoSyncResult = { cloned: [], skipped: [], failed: [] };

	const repos = await db.query<RepoRow>(
		`SELECT repo_identifier FROM repos
		 WHERE project_id = $1 ORDER BY created_at ASC`,
		[project.id],
	);

	if (repos.rows.length === 0) return result;

	const workspacePath = getWorkspacePath(dataDir, project.team_id, project.id);
	mkdirSync(workspacePath, { recursive: true });

	const pending: Array<{ repo: RepoRow; mode: 'clone' | 'init' }> = [];
	for (const r of repos.rows) {
		const name = repoNameFromIdentifier(r.repo_identifier);
		const targetDir = join(workspacePath, name);
		if (existsSync(join(targetDir, '.git'))) {
			result.skipped.push(name);
		} else if (existsSync(targetDir) && readdirSync(targetDir).length > 0) {
			// An agent populated this directory before the repo was connected — a
			// plain clone would refuse the non-empty target, so adopt it in place.
			pending.push({ repo: r, mode: 'init' });
		} else {
			pending.push({ repo: r, mode: 'clone' });
		}
	}

	if (pending.length === 0) return result;

	if (!sshAgentServer) {
		const msg = 'SshAgentServer not available — cannot clone over SSH';
		for (const { repo: r } of pending) {
			logEmit?.('stderr', `✗ ${msg}`);
			result.failed.push({ name: repoNameFromIdentifier(r.repo_identifier), error: msg });
		}
		return result;
	}

	const knownHostsPath = await ensureGithubKnownHosts(dataDir);

	await withHostAgentSocket(sshAgentServer, project.team_id, dataDir, async ({ sshAuthSock }) => {
		for (const { repo: r, mode } of pending) {
			const name = repoNameFromIdentifier(r.repo_identifier);
			const targetDir = join(workspacePath, name);
			const verb = mode === 'init' ? 'Initializing' : 'Cloning';
			logEmit?.('stdout', `→ ${verb} ${r.repo_identifier} → ${name}/`);
			const res =
				mode === 'init'
					? await initRepoInPlace(r.repo_identifier, targetDir, sshAuthSock, knownHostsPath)
					: await cloneRepo(r.repo_identifier, targetDir, sshAuthSock, knownHostsPath);
			if (res.success) {
				logEmit?.('stdout', `✓ ${mode === 'init' ? 'Initialized' : 'Cloned'} ${name}`);
				result.cloned.push(name);
			} else {
				const errMsg = res.error ?? 'unknown error';
				logEmit?.('stderr', `✗ ${verb} failed for ${name}: ${errMsg}`);
				result.failed.push({ name, error: errMsg });
				log.error(`Failed to set up ${r.repo_identifier}`, errMsg);
			}
		}
	});

	return result;
}

interface RepoRow {
	repo_identifier: string;
}

export function removeRepoFromWorkspace(
	dataDir: string,
	teamId: string,
	projectId: string,
	repoName: string,
): void {
	if (!repoName || repoName.includes('/') || repoName === '..' || repoName === '.') return;
	const workspacePath = getWorkspacePath(dataDir, teamId, projectId);
	const repoDir = join(workspacePath, repoName);
	if (existsSync(repoDir)) {
		rmSync(repoDir, { recursive: true, force: true });
	}

	const worktreesRoot = getWorktreesPath(dataDir, teamId, projectId);
	if (!existsSync(worktreesRoot)) return;

	for (const entry of readdirSync(worktreesRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const repoWorktree = join(worktreesRoot, entry.name, repoName);
		if (existsSync(repoWorktree)) {
			rmSync(repoWorktree, { recursive: true, force: true });
		}
	}
}

export function removeTaskWorktrees(
	dataDir: string,
	teamId: string,
	projectId: string,
	taskIdentifier: string,
): void {
	if (
		!taskIdentifier ||
		taskIdentifier.includes('/') ||
		taskIdentifier === '..' ||
		taskIdentifier === '.'
	)
		return;
	const worktreesRoot = getWorktreesPath(dataDir, teamId, projectId);
	const taskDir = join(worktreesRoot, taskIdentifier);
	if (existsSync(taskDir)) {
		rmSync(taskDir, { recursive: true, force: true });
	}
}
