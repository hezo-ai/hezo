import { existsSync, mkdirSync, rmSync } from 'node:fs';
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
