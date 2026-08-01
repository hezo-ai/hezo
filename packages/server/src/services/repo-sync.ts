import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { RepoHostType, repoNameFromIdentifier } from '@hezo/shared';
import type { Db } from '../db/database';
import { logger } from '../logger';
import {
	buildGitSshUrl,
	cloneRepo,
	getOriginRemote,
	initRepoInPlace,
	type RepoLoc,
	remoteUrlMatchesRepo,
	setOriginUrl,
} from './git';
import type { GitExecutor } from './git-executor';
import { CONTAINER_WORKSPACE_ROOT, getWorkspacePath, getWorktreesPath } from './workspace';

const log = logger.child('repo-sync');

export type LogEmitter = (stream: 'stdout' | 'stderr', text: string) => void;

/** Repos keyed by name — the workspace directory each clone lives in. */
export interface RepoSyncResult {
	cloned: string[];
	/** Existing dirs whose broken git state was healed (origin added/repointed). */
	repaired: string[];
	skipped: string[];
	failed: Array<{ name: string; error: string }>;
}

export interface ProjectIdentity {
	id: string;
	team_id: string;
}

/**
 * Clones (or, for a pre-populated dir, adopts in place) every repo linked to the
 * project that isn't already on disk. Git runs in the project container via the
 * passed `executor`; the host only does the `.git`-present / non-empty filesystem
 * checks against the bind-mounted workspace. The container must be running and the
 * executor's bridge must carry the project SSH key, or clone-over-SSH fails and is
 * reported in `failed` (same outcome as a missing key today).
 *
 * A directory that already carries `.git` is not trusted blindly: an agent may
 * have run `git init` in the reserved directory before the repo was connected,
 * leaving a repo with no origin (every fetch then silently no-ops and worktree
 * prep dies on an unborn HEAD) or with origin pointed somewhere else entirely.
 * The sync verifies `origin` actually tracks the linked repo and self-heals when
 * it doesn't — adopting the directory in place when origin is missing, repointing
 * origin when it's wrong — reported in `repaired`. Healing never discards local
 * files or commits; a heal that would clobber untracked work fails instead.
 */
/** Whether the clone directory already holds anything, asked of the container. */
async function hasEntries(loc: RepoLoc): Promise<boolean> {
	return (await loc.files.list('.')).length > 0;
}

export async function ensureProjectRepos(
	db: Db,
	project: ProjectIdentity,
	dataDir: string,
	executor: GitExecutor,
	logEmit?: LogEmitter,
	containerWorkspaceRoot: string = CONTAINER_WORKSPACE_ROOT,
): Promise<RepoSyncResult> {
	const result: RepoSyncResult = { cloned: [], repaired: [], skipped: [], failed: [] };

	const repos = await db.query<RepoRow>(
		`SELECT repo_identifier FROM repos
		 WHERE project_id = $1 ORDER BY created_at ASC`,
		[project.id],
	);

	if (repos.rows.length === 0) return result;

	const workspacePath = getWorkspacePath(dataDir, project.team_id, project.id);
	mkdirSync(workspacePath, { recursive: true });

	type SyncMode = 'clone' | 'init' | 'adopt' | 'repoint';
	const pending: Array<{ repo: RepoRow; mode: SyncMode; loc: RepoLoc; badOrigin?: string }> = [];
	for (const r of repos.rows) {
		const name = repoNameFromIdentifier(r.repo_identifier);

		const containerPath = `${containerWorkspaceRoot}/${name}`;
		const loc: RepoLoc = { containerPath, files: executor.files(containerPath) };
		// Asked of the container, not the host: on a managed backend the clone lives
		// in the sandbox and `targetDir` names an empty host directory, so a host
		// check reported "not cloned" for every repo and re-cloned on every run.
		if (await loc.files.exists('.git')) {
			// Verify — don't trust — the existing `.git` (see the docstring). Only a
			// positively-wrong state is healed; an indeterminate answer leaves the
			// clone alone.
			const origin = await getOriginRemote(executor, loc);
			if (origin.status === 'missing') {
				pending.push({ repo: r, mode: 'adopt', loc });
			} else if (
				origin.status === 'configured' &&
				!remoteUrlMatchesRepo(origin.url, r.repo_identifier)
			) {
				pending.push({ repo: r, mode: 'repoint', loc, badOrigin: origin.url });
			} else {
				result.skipped.push(name);
			}
		} else if (await hasEntries(loc)) {
			// An agent populated this directory before the repo was connected — a
			// plain clone would refuse the non-empty target, so adopt it in place.
			// Asked of the container for the same reason as the `.git` check above:
			// on a managed backend the host directory is always empty, so this branch
			// never fired and every run re-entered `clone`, which then failed against
			// the clone already sitting in the sandbox. Whether a run hit that
			// depended on which pool rung it landed on, so it read as intermittent.
			pending.push({ repo: r, mode: 'init', loc });
		} else {
			pending.push({ repo: r, mode: 'clone', loc });
		}
	}

	if (pending.length === 0) return result;

	const VERBS: Record<SyncMode, [progressive: string, past: string]> = {
		clone: ['Cloning', 'Cloned'],
		init: ['Initializing', 'Initialized'],
		adopt: ['Repairing', 'Repaired'],
		repoint: ['Repairing', 'Repaired'],
	};
	for (const { repo: r, mode, loc, badOrigin } of pending) {
		const name = repoNameFromIdentifier(r.repo_identifier);
		const [verb, done] = VERBS[mode];
		const detail =
			mode === 'adopt'
				? ' (existing directory has no usable origin remote; connecting it in place)'
				: mode === 'repoint'
					? ` (origin pointed at ${badOrigin})`
					: '';
		logEmit?.('stdout', `→ ${verb} ${r.repo_identifier} → ${name}/${detail}`);
		let res: { success: boolean; error?: string };
		switch (mode) {
			case 'clone':
				res = await cloneRepo(executor, r.repo_identifier, loc);
				break;
			case 'init':
			case 'adopt':
				res = await initRepoInPlace(executor, r.repo_identifier, loc);
				break;
			case 'repoint':
				res = await setOriginUrl(
					executor,
					buildGitSshUrl(RepoHostType.GitHub, r.repo_identifier),
					loc,
				);
				break;
		}
		if (res.success) {
			logEmit?.('stdout', `✓ ${done} ${name}`);
			(mode === 'adopt' || mode === 'repoint' ? result.repaired : result.cloned).push(name);
		} else {
			const errMsg = res.error ?? 'unknown error';
			logEmit?.('stderr', `✗ ${verb} failed for ${name}: ${errMsg}`);
			result.failed.push({ name, error: errMsg });
			log.error(`Failed to set up ${r.repo_identifier}`, errMsg);
		}
	}

	return result;
}

interface RepoRow {
	repo_identifier: string;
}

/**
 * **Host-side only, and knowingly so.** These reclaim disk under the operator's
 * data dir, which is the same bytes as the container's workspace only while the
 * container is local. On a managed backend they clean an empty host directory and
 * the sandbox keeps its copy.
 *
 * Left that way deliberately rather than migrated with the rest of the git layer:
 * the consequence there is disk that is not reclaimed early, not a run that
 * behaves wrongly, and the pool's disk-ceiling rung already recycles a container
 * that fills up. Migrating them needs an engine and a container id threaded to
 * the task-close automation and the repo routes, which is a wider change than the
 * run correctness this pass was for.
 */
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
