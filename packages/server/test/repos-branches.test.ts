import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import { waitForBackground } from '../src/lib/background';
import type { Env } from '../src/lib/types';
import { createConnection } from '../src/services/oauth/connection-store';
import { ensureRepoSetupAction } from '../src/services/repo-setup';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';
import { createGitHubSim, type GitHubSim } from './helpers/github-sim';

/**
 * Branch coverage for routes/repos.ts not reached by the existing repos suites:
 *  - first-repo designation that ALSO resolves a pending repo-setup approval and
 *    broadcasts the approval/comment finalize arms (clone "succeeds" because a
 *    .git dir is pre-seeded so repo-sync skips it).
 *  - mode=create whose GitHub create throws → REPO_CREATE_FAILED (500).
 *  - org/repo listing when the master key is locked → OAUTH_TOKEN_UNAVAILABLE.
 *  - DELETE that runs the workspace-cleanup path (dataDir present).
 */

let app: Hono<Env>;
let db: Db;
let token: string;
let teamId: string;
let projectId: string;
let masterKeyManager: MasterKeyManager;
let sim: GitHubSim;
let dataDir: string;
let connId: string;
let prevApi: string | undefined;
const ACCESS_TOKEN = 'gho_repos_branches_token';

function fakeClonedRepoDir(repoName: string) {
	const gitDir = join(
		dataDir,
		'teams',
		teamId,
		'projects',
		projectId,
		'workspace',
		repoName,
		'.git',
	);
	mkdirSync(gitDir, { recursive: true });
	writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
}

function postRepo(body: Record<string, unknown>) {
	return app.request(`/api/projects/${projectId}/repos`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
}

beforeAll(async () => {
	sim = await createGitHubSim();
	prevApi = process.env.GITHUB_API_BASE_URL;
	process.env.GITHUB_API_BASE_URL = sim.baseUrl;
	sim.seed({
		token: ACCESS_TOKEN,
		user: { id: 77, login: 'br-user', avatar_url: '', email: 'br@hezo.test' },
		repos: [
			{
				id: 7,
				name: 'designated-repo',
				full_name: 'br-user/designated-repo',
				owner: { login: 'br-user' },
				private: true,
				default_branch: 'main',
				clone_url: 'https://github.com/br-user/designated-repo.git',
				ssh_url: 'git@github.com:br-user/designated-repo.git',
			},
		],
	});

	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;
	dataDir = ctx.dataDir;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: { name: string }) => t.name === 'App Team',
	).id;
	const teamRes = await createTestTeam(db, { name: 'Repo Branches Co', template_id: typeId });
	teamId = (await teamRes.json()).data.id;
	const projectRes = await createTestProject(db, teamId, { name: 'Repo Branches Project' });
	projectId = (await projectRes.json()).data.id;

	const conn = await createConnection(
		{ db, masterKeyManager },
		{
			provider: 'github',
			providerAccountId: '77',
			providerAccountLabel: 'br-user',
			accessToken: ACCESS_TOKEN,
			scopes: ['repo', 'read:org'],
			allowedHosts: ['github.com', 'api.github.com'],
		},
	);
	connId = conn.id;
});

afterAll(async () => {
	process.env.GITHUB_API_BASE_URL = prevApi;
	await sim.destroy();
	await safeClose(db);
});

describe('POST repos — first-repo designation resolves a pending repo-setup approval', () => {
	it('finalizes the approval, marks the gate comment complete, and broadcasts the finalize arms', async () => {
		// A gated planning-style task with a pending designated-repo approval +
		// SetupRepo action comment, so finalizePendingRepoSetup has something to resolve.
		const meta = await db.query<{ task_prefix: string; number: number }>(
			`SELECT task_prefix, next_project_task_number(id) AS number FROM projects WHERE id = $1`,
			[projectId],
		);
		const gateTask = await db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title, status, priority, labels)
			 VALUES ($1, $2, $3, $4, 'Gated on repo', 'backlog'::task_status, 'high'::task_priority, '[]'::jsonb)
			 RETURNING id`,
			[
				teamId,
				projectId,
				meta.rows[0].number,
				`${meta.rows[0].task_prefix}-${meta.rows[0].number}`,
			],
		);
		const gateTaskId = gateTask.rows[0].id;

		const action = await ensureRepoSetupAction(db, { teamId, projectId, taskId: gateTaskId });
		expect(action.approvalCreated).toBe(true);

		// Container "running" so the post-designation auto-start is a no-op, and a
		// pre-seeded .git dir so the in-container clone is skipped (treated as cloned).
		await db.query(
			`UPDATE projects SET container_id = 'test-container', container_status = 'running' WHERE id = $1`,
			[projectId],
		);
		fakeClonedRepoDir('designated-repo');

		const res = await postRepo({
			mode: 'link',
			url: 'https://github.com/br-user/designated-repo',
			oauth_connection_id: connId,
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		// The response returns before the checkout/designation settles.
		expect(body.data.setup_status).toBe('pending');
		expect(body.data.is_designated).toBe(false);

		// Drain the background setup (clone skipped via the pre-seeded .git dir,
		// then designation + approval finalize).
		await waitForBackground();

		const repoRow = await db.query<{ setup_status: string; setup_error: string | null }>(
			`SELECT setup_status::text AS setup_status, setup_error FROM repos WHERE id = $1`,
			[body.data.id],
		);
		expect(repoRow.rows[0].setup_status).toBe('ready');
		expect(repoRow.rows[0].setup_error).toBeNull();

		// The approval was auto-resolved.
		const approval = await db.query<{ status: string }>(
			`SELECT status::text AS status FROM approvals WHERE id = $1`,
			[action.approvalId],
		);
		expect(approval.rows[0].status).toBe('approved');

		// The gate action comment was marked complete.
		const gateComment = await db.query<{ chosen_option: unknown }>(
			`SELECT chosen_option FROM task_comments WHERE id = $1`,
			[action.commentId],
		);
		expect(gateComment.rows[0].chosen_option).not.toBeNull();

		// A repo_designated system comment landed on the gated task.
		const sys = await db.query<{ c: number }>(
			`SELECT count(*)::int AS c FROM task_comments
			 WHERE task_id = $1 AND content_type = 'system' AND content->>'kind' = 'repo_designated'`,
			[gateTaskId],
		);
		expect(sys.rows[0].c).toBe(1);

		// The project now points at the designated repo.
		const project = await db.query<{ designated_repo_id: string | null }>(
			`SELECT designated_repo_id FROM projects WHERE id = $1`,
			[projectId],
		);
		expect(project.rows[0].designated_repo_id).toBe(body.data.id);
	});
});

describe('POST repos — mode=create failure path', () => {
	it('returns 500 REPO_CREATE_FAILED when the GitHub create call throws', async () => {
		// Point the GitHub API base at a dead port so createGitHubRepo throws (network
		// error) rather than returning a structured already_exists result.
		const saved = process.env.GITHUB_API_BASE_URL;
		process.env.GITHUB_API_BASE_URL = 'http://127.0.0.1:1';
		try {
			const res = await postRepo({
				mode: 'create',
				owner: 'br-user',
				name: 'will-fail',
				private: true,
				oauth_connection_id: connId,
			});
			expect(res.status).toBe(500);
			expect((await res.json()).error.code).toBe('REPO_CREATE_FAILED');
		} finally {
			process.env.GITHUB_API_BASE_URL = saved;
		}
	});
});

describe('GET oauth-connections listing — master key unavailable', () => {
	// The JWT auth path verifies signatures against the enrolled public key, not
	// the symmetric encryption key, so the admin token still authenticates after
	// the encryption key is cleared. loadOAuthAccessToken then returns null
	// (key === null) → the route reports OAUTH_TOKEN_UNAVAILABLE.
	type Lockable = { key: Buffer | null };
	function withLockedKey<T>(fn: () => Promise<T>): Promise<T> {
		const m = masterKeyManager as unknown as Lockable;
		const saved = m.key;
		m.key = null;
		return fn().finally(() => {
			m.key = saved;
		});
	}

	it('orgs listing returns 503 OAUTH_TOKEN_UNAVAILABLE when the key is unavailable', async () => {
		const res = await withLockedKey(async () =>
			app.request(`/api/projects/${projectId}/oauth-connections/${connId}/orgs`, {
				headers: authHeader(token),
			}),
		);
		expect(res.status).toBe(503);
		expect((await res.json()).error.code).toBe('OAUTH_TOKEN_UNAVAILABLE');
	});

	it('repos listing returns 503 OAUTH_TOKEN_UNAVAILABLE when the key is unavailable', async () => {
		const res = await withLockedKey(async () =>
			app.request(`/api/projects/${projectId}/oauth-connections/${connId}/repos?owner=br-user`, {
				headers: authHeader(token),
			}),
		);
		expect(res.status).toBe(503);
		expect((await res.json()).error.code).toBe('OAUTH_TOKEN_UNAVAILABLE');
	});
});

describe('DELETE repos — workspace cleanup path', () => {
	it('deletes a non-designated repo and runs the workspace cleanup (dataDir present)', async () => {
		const inserted = await db.query<{ id: string }>(
			`INSERT INTO repos (project_id, repo_identifier, host_type)
			 VALUES ($1, 'br-user/cleanup-me', 'github') RETURNING id`,
			[projectId],
		);
		// Seed a workspace dir so removeRepoFromWorkspace has something to remove.
		fakeClonedRepoDir('cleanup-me');

		const res = await app.request(`/api/projects/${projectId}/repos/${inserted.rows[0].id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.deleted).toBe(true);
	});
});
