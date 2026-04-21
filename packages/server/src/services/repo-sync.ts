import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import type { MasterKeyManager } from '../crypto/master-key';
import { logger } from '../logger';
import { cloneRepo } from './git';
import { getCompanySSHKey } from './ssh-keys';
import { getWorkspacePath, getWorktreesPath } from './workspace';

const log = logger.child('repo-sync');

export type LogEmitter = (stream: 'stdout' | 'stderr', text: string) => void;

export interface RepoSyncResult {
	cloned: string[];
	skipped: string[];
	failed: Array<{ short_name: string; error: string }>;
}

export interface ProjectIdentity {
	id: string;
	company_id: string;
	companySlug: string;
	projectSlug: string;
}

export async function ensureProjectRepos(
	db: PGlite,
	masterKeyManager: MasterKeyManager,
	project: ProjectIdentity,
	dataDir: string,
	logEmit?: LogEmitter,
): Promise<RepoSyncResult> {
	const result: RepoSyncResult = { cloned: [], skipped: [], failed: [] };

	const repos = await db.query<RepoRow>(
		`SELECT short_name, repo_identifier FROM repos
		 WHERE project_id = $1 ORDER BY created_at ASC`,
		[project.id],
	);

	if (repos.rows.length === 0) return result;

	const workspacePath = getWorkspacePath(dataDir, project.companySlug, project.projectSlug);
	mkdirSync(workspacePath, { recursive: true });

	const pending: RepoRow[] = [];
	for (const r of repos.rows) {
		const targetDir = join(workspacePath, r.short_name);
		if (existsSync(join(targetDir, '.git'))) {
			result.skipped.push(r.short_name);
		} else {
			pending.push(r);
		}
	}

	if (pending.length === 0) return result;

	const sshKey = await getCompanySSHKey(db, project.company_id, masterKeyManager);
	if (!sshKey) {
		const msg = 'No company SSH key configured';
		logEmit?.('stderr', `✗ ${msg}`);
		for (const r of pending) {
			result.failed.push({ short_name: r.short_name, error: msg });
		}
		return result;
	}

	for (const r of pending) {
		const targetDir = join(workspacePath, r.short_name);
		logEmit?.('stdout', `→ Cloning ${r.repo_identifier} into ${r.short_name}/`);
		const clone = await cloneRepo(r.repo_identifier, targetDir, sshKey.privateKey);
		if (clone.success) {
			logEmit?.('stdout', `✓ Cloned ${r.short_name}`);
			result.cloned.push(r.short_name);
		} else {
			const errMsg = clone.error ?? 'unknown error';
			logEmit?.('stderr', `✗ Clone failed for ${r.short_name}: ${errMsg}`);
			result.failed.push({ short_name: r.short_name, error: errMsg });
			log.error(`Failed to clone ${r.repo_identifier}`, errMsg);
		}
	}

	return result;
}

interface RepoRow {
	short_name: string;
	repo_identifier: string;
}

export function removeRepoFromWorkspace(
	dataDir: string,
	companySlug: string,
	projectSlug: string,
	shortName: string,
): void {
	if (!shortName || shortName.includes('/') || shortName === '..' || shortName === '.') return;
	const workspacePath = getWorkspacePath(dataDir, companySlug, projectSlug);
	const repoDir = join(workspacePath, shortName);
	if (existsSync(repoDir)) {
		rmSync(repoDir, { recursive: true, force: true });
	}

	const worktreesRoot = getWorktreesPath(dataDir, companySlug, projectSlug);
	if (!existsSync(worktreesRoot)) return;

	for (const entry of readdirSync(worktreesRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const repoWorktree = join(worktreesRoot, entry.name, shortName);
		if (existsSync(repoWorktree)) {
			rmSync(repoWorktree, { recursive: true, force: true });
		}
	}
}

export function removeIssueWorktrees(
	dataDir: string,
	companySlug: string,
	projectSlug: string,
	issueIdentifier: string,
): void {
	if (
		!issueIdentifier ||
		issueIdentifier.includes('/') ||
		issueIdentifier === '..' ||
		issueIdentifier === '.'
	)
		return;
	const worktreesRoot = getWorktreesPath(dataDir, companySlug, projectSlug);
	const issueDir = join(worktreesRoot, issueIdentifier);
	if (existsSync(issueDir)) {
		rmSync(issueDir, { recursive: true, force: true });
	}
}
