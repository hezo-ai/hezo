import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/lib/types';
import { HostGitExecutor } from '../src/services/git-executor';
import {
	ensureProjectRepos,
	removeRepoFromWorkspace,
	removeTaskWorktrees,
} from '../src/services/repo-sync';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let teamId: string;
let projectId: string;
let dataDir: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	dataDir = ctx.dataDir;

	const teamRes = await createTestTeam(db, { name: 'Repo Sync Co' });
	const team = (await teamRes.json()).data;
	teamId = team.id;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Main',
		description: 'Test project.',
	});
	const project = (await projectRes.json()).data;
	projectId = project.id;
});

afterAll(async () => {
	await safeClose(db);
});

// The clone path runs in-container; these cases (no repos, already-cloned) never
// reach the executor, so a host executor suffices and no Docker is needed.
const exec = new HostGitExecutor();

describe('ensureProjectRepos', () => {
	it('returns empty result when no repos are linked', async () => {
		const result = await ensureProjectRepos(db, { id: projectId, team_id: teamId }, dataDir, exec);
		expect(result.cloned).toEqual([]);
		expect(result.skipped).toEqual([]);
		expect(result.failed).toEqual([]);
	});

	it('skips repos whose target dir already contains .git', async () => {
		// Insert a repo record directly; emulate an existing clone by creating .git.
		await db.query(
			`INSERT INTO repos (project_id, repo_identifier, host_type)
			 VALUES ($1, 'owner/preexisting', 'github'::repo_host_type)`,
			[projectId],
		);

		const workspacePath = join(dataDir, 'teams', teamId, 'projects', projectId, 'workspace');
		const targetDir = join(workspacePath, 'preexisting');
		mkdirSync(join(targetDir, '.git'), { recursive: true });
		writeFileSync(join(targetDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');

		const logs: Array<{ stream: string; text: string }> = [];
		const result = await ensureProjectRepos(
			db,
			{ id: projectId, team_id: teamId },
			dataDir,
			exec,
			(stream, text) => logs.push({ stream, text }),
		);
		expect(result.skipped).toContain('preexisting');
		expect(result.cloned).not.toContain('preexisting');
	});
});

describe('removeRepoFromWorkspace', () => {
	it('removes the repo subdirectory and its per-task worktrees', async () => {
		const workspacePath = join(dataDir, 'teams', teamId, 'projects', projectId, 'workspace');
		const worktreesPath = join(dataDir, 'teams', teamId, 'projects', projectId, 'worktrees');

		const repoDir = join(workspacePath, 'to-remove');
		mkdirSync(join(repoDir, '.git'), { recursive: true });

		const wtDir1 = join(worktreesPath, 'RS-1', 'to-remove');
		const wtDir2 = join(worktreesPath, 'RS-2', 'to-remove');
		mkdirSync(wtDir1, { recursive: true });
		mkdirSync(wtDir2, { recursive: true });

		removeRepoFromWorkspace(dataDir, teamId, projectId, 'to-remove');

		expect(existsSync(repoDir)).toBe(false);
		expect(existsSync(wtDir1)).toBe(false);
		expect(existsSync(wtDir2)).toBe(false);
	});

	it('is a no-op for dangerous repo name values', () => {
		const workspacePath = join(dataDir, 'teams', teamId, 'projects', projectId, 'workspace');
		const stayDir = join(workspacePath, 'stay');
		mkdirSync(stayDir, { recursive: true });

		removeRepoFromWorkspace(dataDir, teamId, projectId, '..');
		removeRepoFromWorkspace(dataDir, teamId, projectId, 'has/slash');
		removeRepoFromWorkspace(dataDir, teamId, projectId, '');

		expect(existsSync(stayDir)).toBe(true);
	});
});

describe('removeTaskWorktrees', () => {
	it('removes the task directory under worktrees', () => {
		const worktreesPath = join(dataDir, 'teams', teamId, 'projects', projectId, 'worktrees');
		const taskDir = join(worktreesPath, 'RS-9');
		mkdirSync(join(taskDir, 'main'), { recursive: true });
		mkdirSync(join(taskDir, 'secondary'), { recursive: true });

		removeTaskWorktrees(dataDir, teamId, projectId, 'RS-9');

		expect(existsSync(taskDir)).toBe(false);
	});

	it('is a no-op for dangerous identifier values', () => {
		const worktreesPath = join(dataDir, 'teams', teamId, 'projects', projectId, 'worktrees');
		const stayDir = join(worktreesPath, 'RS-10');
		mkdirSync(stayDir, { recursive: true });

		removeTaskWorktrees(dataDir, teamId, projectId, '..');
		removeTaskWorktrees(dataDir, teamId, projectId, '');

		expect(existsSync(stayDir)).toBe(true);
	});
});
