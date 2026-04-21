import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../../crypto/master-key';
import type { Env } from '../../lib/types';
import {
	ensureProjectRepos,
	removeIssueWorktrees,
	removeRepoFromWorkspace,
} from '../../services/repo-sync';
import { safeClose } from '../helpers';
import { authHeader, createTestApp } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let masterKeyManager: MasterKeyManager;
let companyId: string;
let companySlug: string;
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

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Repo Sync Co', issue_prefix: 'RS' }),
	});
	const company = (await companyRes.json()).data;
	companyId = company.id;
	companySlug = company.slug;

	const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Main', description: 'Test project.' }),
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
			{ id: projectId, company_id: companyId, companySlug, projectSlug },
			dataDir,
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

		const workspacePath = join(
			dataDir,
			'companies',
			companySlug,
			'projects',
			projectSlug,
			'workspace',
		);
		const targetDir = join(workspacePath, 'preexisting');
		mkdirSync(join(targetDir, '.git'), { recursive: true });
		writeFileSync(join(targetDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');

		const logs: Array<{ stream: string; text: string }> = [];
		const result = await ensureProjectRepos(
			db,
			masterKeyManager,
			{ id: projectId, company_id: companyId, companySlug, projectSlug },
			dataDir,
			(stream, text) => logs.push({ stream, text }),
		);
		expect(result.skipped).toContain('preexisting');
		expect(result.cloned).not.toContain('preexisting');
	});
});

describe('removeRepoFromWorkspace', () => {
	it('removes the repo subdirectory and its per-issue worktrees', async () => {
		const workspacePath = join(
			dataDir,
			'companies',
			companySlug,
			'projects',
			projectSlug,
			'workspace',
		);
		const worktreesPath = join(
			dataDir,
			'companies',
			companySlug,
			'projects',
			projectSlug,
			'worktrees',
		);

		const repoDir = join(workspacePath, 'to-remove');
		mkdirSync(join(repoDir, '.git'), { recursive: true });

		const wtDir1 = join(worktreesPath, 'RS-1', 'to-remove');
		const wtDir2 = join(worktreesPath, 'RS-2', 'to-remove');
		mkdirSync(wtDir1, { recursive: true });
		mkdirSync(wtDir2, { recursive: true });

		removeRepoFromWorkspace(dataDir, companySlug, projectSlug, 'to-remove');

		expect(existsSync(repoDir)).toBe(false);
		expect(existsSync(wtDir1)).toBe(false);
		expect(existsSync(wtDir2)).toBe(false);
	});

	it('is a no-op for dangerous short_name values', () => {
		const workspacePath = join(
			dataDir,
			'companies',
			companySlug,
			'projects',
			projectSlug,
			'workspace',
		);
		const stayDir = join(workspacePath, 'stay');
		mkdirSync(stayDir, { recursive: true });

		removeRepoFromWorkspace(dataDir, companySlug, projectSlug, '..');
		removeRepoFromWorkspace(dataDir, companySlug, projectSlug, 'has/slash');
		removeRepoFromWorkspace(dataDir, companySlug, projectSlug, '');

		expect(existsSync(stayDir)).toBe(true);
	});
});

describe('removeIssueWorktrees', () => {
	it('removes the issue directory under worktrees', () => {
		const worktreesPath = join(
			dataDir,
			'companies',
			companySlug,
			'projects',
			projectSlug,
			'worktrees',
		);
		const issueDir = join(worktreesPath, 'RS-9');
		mkdirSync(join(issueDir, 'main'), { recursive: true });
		mkdirSync(join(issueDir, 'secondary'), { recursive: true });

		removeIssueWorktrees(dataDir, companySlug, projectSlug, 'RS-9');

		expect(existsSync(issueDir)).toBe(false);
	});

	it('is a no-op for dangerous identifier values', () => {
		const worktreesPath = join(
			dataDir,
			'companies',
			companySlug,
			'projects',
			projectSlug,
			'worktrees',
		);
		const stayDir = join(worktreesPath, 'RS-10');
		mkdirSync(stayDir, { recursive: true });

		removeIssueWorktrees(dataDir, companySlug, projectSlug, '..');
		removeIssueWorktrees(dataDir, companySlug, projectSlug, '');

		expect(existsSync(stayDir)).toBe(true);
	});
});
