import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Where the project workspace + worktrees are bind-mounted inside the container
// (see the `Binds` in containers.ts). Git runs in-container, so every git cwd /
// path argument is addressed under these roots, not the host `<dataDir>` paths.
export const CONTAINER_WORKSPACE_ROOT = '/workspace';
export const CONTAINER_WORKTREES_ROOT = '/worktrees';

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

export function ensureProjectWorkspace(dataDir: string, teamId: string, projectId: string): string {
	if (!dataDir || !teamId || !projectId) {
		throw new Error('dataDir, teamId, and projectId are required');
	}
	const projectDir = getProjectDir(dataDir, teamId, projectId);
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

export function removeProjectWorkspace(dataDir: string, teamId: string, projectId: string): void {
	if (!dataDir || !teamId || !projectId) return;
	const projectDir = getProjectDir(dataDir, teamId, projectId);
	forceRmRecursive(projectDir);
}

// Project infrastructure (workspace, worktrees, previews, assets) is keyed on the
// immutable team and project ids — never their slugs — so renaming a team or
// project never changes where files live or which directory a container mounts.
export function getProjectDir(dataDir: string, teamId: string, projectId: string): string {
	return join(dataDir, 'teams', teamId, 'projects', projectId);
}

export function getWorkspacePath(dataDir: string, teamId: string, projectId: string): string {
	return join(getProjectDir(dataDir, teamId, projectId), 'workspace');
}

export function getAssetsPath(dataDir: string, teamId: string, projectId: string): string {
	return join(getProjectDir(dataDir, teamId, projectId), 'assets');
}

export function getAssetPath(
	dataDir: string,
	teamId: string,
	projectId: string,
	assetId: string,
): string {
	return join(getAssetsPath(dataDir, teamId, projectId), assetId);
}

export function getWorktreesPath(dataDir: string, teamId: string, projectId: string): string {
	return join(getProjectDir(dataDir, teamId, projectId), 'worktrees');
}

export function getWorktreePath(
	dataDir: string,
	teamId: string,
	projectId: string,
	repoName: string,
	branchSlug: string,
	agentIdShort: string,
): string {
	return join(
		getWorktreesPath(dataDir, teamId, projectId),
		`${repoName}-${branchSlug}-agent-${agentIdShort}`,
	);
}

export function getPreviewsPath(
	dataDir: string,
	teamId: string,
	projectId: string,
	agentId: string,
): string {
	return join(getProjectDir(dataDir, teamId, projectId), '.previews', agentId);
}

export function clearAllProjectWorkspaces(dataDir: string): string[] {
	if (!dataDir) return [];
	const teamsRoot = join(dataDir, 'teams');
	if (!existsSync(teamsRoot)) return [];

	const cleared: string[] = [];
	for (const teamDir of safeReaddir(teamsRoot)) {
		const projectsRoot = join(teamsRoot, teamDir, 'projects');
		if (!isDirectory(projectsRoot)) continue;

		for (const projectDir of safeReaddir(projectsRoot)) {
			const workspaceDir = join(projectsRoot, projectDir, 'workspace');
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
