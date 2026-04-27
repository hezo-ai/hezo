import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function ensureProjectWorkspace(
	dataDir: string,
	companySlug: string,
	projectSlug: string,
): string {
	if (!dataDir || !companySlug || !projectSlug) {
		throw new Error('dataDir, companySlug, and projectSlug are required');
	}
	const projectDir = getProjectDir(dataDir, companySlug, projectSlug);
	for (const sub of ['workspace', 'worktrees', '.previews']) {
		mkdirSync(join(projectDir, sub), { recursive: true });
	}
	return projectDir;
}

export function removeProjectWorkspace(
	dataDir: string,
	companySlug: string,
	projectSlug: string,
): void {
	if (!dataDir || !companySlug || !projectSlug) return;
	const projectDir = getProjectDir(dataDir, companySlug, projectSlug);
	if (existsSync(projectDir)) {
		rmSync(projectDir, { recursive: true, force: true });
	}
}

export function getProjectDir(dataDir: string, companySlug: string, projectSlug: string): string {
	return join(dataDir, 'companies', companySlug, 'projects', projectSlug);
}

export function getWorkspacePath(
	dataDir: string,
	companySlug: string,
	projectSlug: string,
): string {
	return join(getProjectDir(dataDir, companySlug, projectSlug), 'workspace');
}

export function getWorktreesPath(
	dataDir: string,
	companySlug: string,
	projectSlug: string,
): string {
	return join(getProjectDir(dataDir, companySlug, projectSlug), 'worktrees');
}

export function getWorktreePath(
	dataDir: string,
	companySlug: string,
	projectSlug: string,
	repoShortName: string,
	branchSlug: string,
	agentIdShort: string,
): string {
	return join(
		getWorktreesPath(dataDir, companySlug, projectSlug),
		`${repoShortName}-${branchSlug}-agent-${agentIdShort}`,
	);
}

export function getPreviewsPath(
	dataDir: string,
	companySlug: string,
	projectSlug: string,
	agentId: string,
): string {
	return join(getProjectDir(dataDir, companySlug, projectSlug), '.previews', agentId);
}

export function clearAllProjectWorkspaces(dataDir: string): string[] {
	if (!dataDir) return [];
	const companiesRoot = join(dataDir, 'companies');
	if (!existsSync(companiesRoot)) return [];

	const cleared: string[] = [];
	for (const companySlug of safeReaddir(companiesRoot)) {
		const projectsRoot = join(companiesRoot, companySlug, 'projects');
		if (!isDirectory(projectsRoot)) continue;

		for (const projectSlug of safeReaddir(projectsRoot)) {
			const workspaceDir = join(projectsRoot, projectSlug, 'workspace');
			if (!isDirectory(workspaceDir)) continue;
			rmSync(workspaceDir, { recursive: true, force: true });
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
