import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function forceRmRecursive(path: string): void {
	if (!existsSync(path)) return;
	try {
		rmSync(path, { recursive: true, force: true });
		return;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code !== 'EACCES' && code !== 'EPERM') throw err;
	}
	// macOS Docker Desktop tags container-mountpoint phantom dirs with a
	// `deny delete` ACL that rmSync cannot override. Strip ACLs and retry.
	if (process.platform === 'darwin') {
		spawnSync('chmod', ['-RN', path]);
	}
	rmSync(path, { recursive: true, force: true });
}

export function ensureProjectWorkspace(
	dataDir: string,
	teamSlug: string,
	projectSlug: string,
): string {
	if (!dataDir || !teamSlug || !projectSlug) {
		throw new Error('dataDir, teamSlug, and projectSlug are required');
	}
	const projectDir = getProjectDir(dataDir, teamSlug, projectSlug);
	for (const sub of ['workspace', 'worktrees', '.previews', 'assets']) {
		mkdirSync(join(projectDir, sub), { recursive: true });
	}
	return projectDir;
}

export function getRunSocketDir(dataDir: string): string {
	const tag = createHash('sha1').update(dataDir).digest('hex').slice(0, 8);
	return join(tmpdir(), `hezo-${tag}`);
}

export function getRunSocketPath(dataDir: string, runId: string): string {
	const id = createHash('sha1').update(runId).digest('hex').slice(0, 12);
	return join(getRunSocketDir(dataDir), `${id}.sock`);
}

export function removeProjectWorkspace(
	dataDir: string,
	teamSlug: string,
	projectSlug: string,
): void {
	if (!dataDir || !teamSlug || !projectSlug) return;
	const projectDir = getProjectDir(dataDir, teamSlug, projectSlug);
	forceRmRecursive(projectDir);
}

export function getProjectDir(dataDir: string, teamSlug: string, projectSlug: string): string {
	return join(dataDir, 'teams', teamSlug, 'projects', projectSlug);
}

export function getWorkspacePath(dataDir: string, teamSlug: string, projectSlug: string): string {
	return join(getProjectDir(dataDir, teamSlug, projectSlug), 'workspace');
}

export function getAssetsPath(dataDir: string, teamSlug: string, projectSlug: string): string {
	return join(getProjectDir(dataDir, teamSlug, projectSlug), 'assets');
}

export function getAssetPath(
	dataDir: string,
	teamSlug: string,
	projectSlug: string,
	assetId: string,
): string {
	return join(getAssetsPath(dataDir, teamSlug, projectSlug), assetId);
}

export function getWorktreesPath(dataDir: string, teamSlug: string, projectSlug: string): string {
	return join(getProjectDir(dataDir, teamSlug, projectSlug), 'worktrees');
}

export function getWorktreePath(
	dataDir: string,
	teamSlug: string,
	projectSlug: string,
	repoShortName: string,
	branchSlug: string,
	agentIdShort: string,
): string {
	return join(
		getWorktreesPath(dataDir, teamSlug, projectSlug),
		`${repoShortName}-${branchSlug}-agent-${agentIdShort}`,
	);
}

export function getPreviewsPath(
	dataDir: string,
	teamSlug: string,
	projectSlug: string,
	agentId: string,
): string {
	return join(getProjectDir(dataDir, teamSlug, projectSlug), '.previews', agentId);
}

export function clearAllProjectWorkspaces(dataDir: string): string[] {
	if (!dataDir) return [];
	const teamsRoot = join(dataDir, 'teams');
	if (!existsSync(teamsRoot)) return [];

	const cleared: string[] = [];
	for (const teamSlug of safeReaddir(teamsRoot)) {
		const projectsRoot = join(teamsRoot, teamSlug, 'projects');
		if (!isDirectory(projectsRoot)) continue;

		for (const projectSlug of safeReaddir(projectsRoot)) {
			const workspaceDir = join(projectsRoot, projectSlug, 'workspace');
			if (!isDirectory(workspaceDir)) continue;
			forceRmRecursive(workspaceDir);
			mkdirSync(workspaceDir, { recursive: true });
			cleared.push(workspaceDir);
		}
	}
	return cleared;
}

function safeReaddir(path: string): string[] {
	try {
		return readdirSync(path);
	} catch {
		return [];
	}
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}
