import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../../crypto/master-key';
import type { Env } from '../../lib/types';
import {
	ensureProjectRepos,
	removeRepoFromWorkspace,
	removeTaskWorktrees,
} from '../../services/repo-sync';
import { safeClose } from '../helpers';
import { authHeader, createTestApp, createTestProject } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let teamSlug: string;
let projectId: string;
let projectSlug: string;
let dataDir: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;
	dataDir = ctx.dataDir;

	const teamRes = await app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Repo Sync Co' }),
	});
	const team = (await teamRes.json()).data;
	teamId = team.id;
	teamSlug = team.slug;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Main',
		description: 'Test project.',
	});
	const project = (await projectRes.json()).data;
	projectId = project.id;
	projectSlug = project.slug;
});

afterAll(async () => {
	await safeClose(db);
});

describe('ensureProjectRepos', () => {
	it('returns empty result when no repos are linked', async () => {
		const result = await ensureProjectRepos(
			db,
			masterKeyManager,
			{ id: projectId, team_id: teamId, teamSlug, projectSlug },
			dataDir,
			null,
		);
		expect(result.cloned).toEqual([]);
		expect(result.skipped).toEqual([]);
		expect(result.failed).toEqual([]);
	});

	it('skips repos whose target dir already contains .git', async () => {
		// Insert a repo record directly; emulate an existing clone by creating .git.
		await db.query(
			`INSERT INTO repos (project_id, short_name, repo_identifier, host_type)
			 VALUES ($1, 'preexisting', 'owner/preexisting', 'github'::repo_host_type)`,
			[projectId],
		);

		const workspacePath = join(dataDir, 'teams', teamSlug, 'projects', projectSlug, 'workspace');
		const targetDir = join(workspacePath, 'preexisting');
		mkdirSync(join(targetDir, '.git'), { recursive: true });
		writeFileSync(join(targetDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');

		const logs: Array<{ stream: string; text: string }> = [];
		const result = await ensureProjectRepos(
			db,
			masterKeyManager,
			{ id: projectId, team_id: teamId, teamSlug, projectSlug },
			dataDir,
			null,
			(stream, text) => logs.push({ stream, text }),
		);
		expect(result.skipped).toContain('preexisting');
		expect(result.cloned).not.toContain('preexisting');
	});
});

describe('removeRepoFromWorkspace', () => {
	it('removes the repo subdirectory and its per-task worktrees', async () => {
		const workspacePath = join(dataDir, 'teams', teamSlug, 'projects', projectSlug, 'workspace');
		const worktreesPath = join(dataDir, 'teams', teamSlug, 'projects', projectSlug, 'worktrees');

		const repoDir = join(workspacePath, 'to-remove');
		mkdirSync(join(repoDir, '.git'), { recursive: true });

		const wtDir1 = join(worktreesPath, 'RS-1', 'to-remove');
		const wtDir2 = join(worktreesPath, 'RS-2', 'to-remove');
		mkdirSync(wtDir1, { recursive: true });
		mkdirSync(wtDir2, { recursive: true });

		removeRepoFromWorkspace(dataDir, teamSlug, projectSlug, 'to-remove');

		expect(existsSync(repoDir)).toBe(false);
		expect(existsSync(wtDir1)).toBe(false);
		expect(existsSync(wtDir2)).toBe(false);
	});

	it('is a no-op for dangerous short_name values', () => {
		const workspacePath = join(dataDir, 'teams', teamSlug, 'projects', projectSlug, 'workspace');
		const stayDir = join(workspacePath, 'stay');
		mkdirSync(stayDir, { recursive: true });

		removeRepoFromWorkspace(dataDir, teamSlug, projectSlug, '..');
		removeRepoFromWorkspace(dataDir, teamSlug, projectSlug, 'has/slash');
		removeRepoFromWorkspace(dataDir, teamSlug, projectSlug, '');

		expect(existsSync(stayDir)).toBe(true);
	});
});

describe('removeTaskWorktrees', () => {
	it('removes the task directory under worktrees', () => {
		const worktreesPath = join(dataDir, 'teams', teamSlug, 'projects', projectSlug, 'worktrees');
		const taskDir = join(worktreesPath, 'RS-9');
		mkdirSync(join(taskDir, 'main'), { recursive: true });
		mkdirSync(join(taskDir, 'secondary'), { recursive: true });

		removeTaskWorktrees(dataDir, teamSlug, projectSlug, 'RS-9');

		expect(existsSync(taskDir)).toBe(false);
	});

	it('is a no-op for dangerous identifier values', () => {
		const worktreesPath = join(dataDir, 'teams', teamSlug, 'projects', projectSlug, 'worktrees');
		const stayDir = join(worktreesPath, 'RS-10');
		mkdirSync(stayDir, { recursive: true });

		removeTaskWorktrees(dataDir, teamSlug, projectSlug, '..');
		removeTaskWorktrees(dataDir, teamSlug, projectSlug, '');

		expect(existsSync(stayDir)).toBe(true);
	});
});
