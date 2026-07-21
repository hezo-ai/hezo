import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import { waitForBackground } from '../src/lib/background';
import type { Env } from '../src/lib/types';
import { createConnection } from '../src/services/oauth/connection-store';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';
import { createGitHubSim, type GitHubSim } from './helpers/github-sim';

let app: Hono<Env>;
let db: Db;
let token: string;
let teamId: string;
let projectId: string;
let masterKeyManager: MasterKeyManager;
let sim: GitHubSim;

let prevApi: string | undefined;
const ACCESS_TOKEN = 'gho_repos_cov_token';

// An active GitHub OAuth connection whose token the sim accepts.
let connId: string;

beforeAll(async () => {
	sim = await createGitHubSim();
	prevApi = process.env.GITHUB_API_BASE_URL;
	process.env.GITHUB_API_BASE_URL = sim.baseUrl;
	sim.seed({
		token: ACCESS_TOKEN,
		user: { id: 42, login: 'sim-user', avatar_url: '', email: 'sim@hezo.test' },
		// A repo the OAuth user can access (for mode=link).
		repos: [
			{
				id: 5,
				name: 'existing-repo',
				full_name: 'sim-user/existing-repo',
				owner: { login: 'sim-user' },
				private: true,
				default_branch: 'main',
				clone_url: 'https://github.com/sim-user/existing-repo.git',
				ssh_url: 'git@github.com:sim-user/existing-repo.git',
			},
		],
	});

	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const types = (await typesRes.json()).data;
	const builtinTypeId = types.find((t: { name: string }) => t.name === 'App Team').id;
	const teamRes = await createTestTeam(db, { name: 'Repo Cov Co', template_id: builtinTypeId });
	teamId = (await teamRes.json()).data.id;
	const projectRes = await createTestProject(db, teamId, { name: 'Repo Cov Project' });
	projectId = (await projectRes.json()).data.id;

	const conn = await createConnection(
		{ db, masterKeyManager },
		{
			provider: 'github',
			providerAccountId: '42',
			providerAccountLabel: 'sim-user',
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

function postRepo(body: Record<string, unknown>) {
	return app.request(`/api/projects/${projectId}/repos`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
}

describe('POST repos — request validation branches', () => {
	it('404s when the project does not resolve', async () => {
		const res = await app.request('/api/projects/no-such-project/repos', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ oauth_connection_id: connId }),
		});
		expect(res.status).toBe(404);
	});

	it('requires url for mode=link', async () => {
		const res = await postRepo({ mode: 'link', oauth_connection_id: connId });
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('INVALID_REQUEST');
	});

	it('rejects a non-GitHub url for mode=link', async () => {
		const res = await postRepo({
			mode: 'link',
			url: 'https://example.com/x/y',
			oauth_connection_id: connId,
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('INVALID_URL');
	});

	it('requires owner and name for mode=create', async () => {
		const res = await postRepo({ mode: 'create', owner: 'sim-user', oauth_connection_id: connId });
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('INVALID_REQUEST');
	});

	it('rejects an unknown mode', async () => {
		const res = await postRepo({ mode: 'mirror', oauth_connection_id: connId });
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('INVALID_REQUEST');
	});

	it('requires oauth_connection_id', async () => {
		const res = await postRepo({ mode: 'link', url: 'sim-user/existing-repo' });
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('INVALID_REQUEST');
	});

	it('404s when the oauth connection is not found', async () => {
		const res = await postRepo({
			mode: 'link',
			url: 'sim-user/existing-repo',
			oauth_connection_id: '00000000-0000-0000-0000-000000000000',
		});
		expect(res.status).toBe(404);
		expect((await res.json()).error.code).toBe('NOT_FOUND');
	});

	it('rejects an oauth connection that is not for GitHub', async () => {
		const other = await createConnection(
			{ db, masterKeyManager },
			{
				provider: 'linear',
				providerAccountId: 'lin-1',
				providerAccountLabel: 'linear-acct',
				accessToken: 'tok',
				scopes: [],
				allowedHosts: ['api.linear.app'],
			},
		);
		const res = await postRepo({
			mode: 'link',
			url: 'sim-user/existing-repo',
			oauth_connection_id: other.id,
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('INVALID_REQUEST');
	});
});

describe('POST repos — mode=link access branches', () => {
	it('403s when the repo is not accessible with the token', async () => {
		const res = await postRepo({
			mode: 'link',
			url: 'sim-user/private-no-access',
			oauth_connection_id: connId,
		});
		expect(res.status).toBe(403);
		expect((await res.json()).error.code).toBe('REPO_NOT_ACCESSIBLE');
	});

	// The first repo on a project would become its designated repo. Designation is
	// deferred until the checkout exists, so under the test harness (stub docker,
	// no real in-container clone) the background setup fails → the row parks
	// `failed` with the error recorded (never deleted), the project stays
	// undesignated, and a retry can reclaim the row. The [error] lines this logs
	// are this suite asserting on that failure path.
	let failedRepoId: string;

	it('201s pending, then parks the row failed when the clone fails', async () => {
		const res = await postRepo({
			mode: 'link',
			url: 'sim-user/existing-repo',
			oauth_connection_id: connId,
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.setup_status).toBe('pending');
		expect(body.data.is_designated).toBe(false);

		await waitForBackground();

		const row = await db.query<{ id: string; setup_status: string; setup_error: string | null }>(
			`SELECT id, setup_status::text AS setup_status, setup_error FROM repos
			 WHERE project_id = $1 AND repo_identifier = 'sim-user/existing-repo'`,
			[projectId],
		);
		expect(row.rows).toHaveLength(1);
		expect(row.rows[0].setup_status).toBe('failed');
		expect(row.rows[0].setup_error).toBeTruthy();
		failedRepoId = row.rows[0].id;

		// A repo whose checkout never materialized must not become designated.
		const project = await db.query<{ designated_repo_id: string | null }>(
			'SELECT designated_repo_id FROM projects WHERE id = $1',
			[projectId],
		);
		expect(project.rows[0].designated_repo_id).toBeNull();
	});

	it('409s (REPO_SETUP_IN_PROGRESS) while a setup for the same repo is still pending', async () => {
		await db.query(`UPDATE repos SET setup_status = 'pending' WHERE id = $1`, [failedRepoId]);
		const res = await postRepo({
			mode: 'link',
			url: 'sim-user/existing-repo',
			oauth_connection_id: connId,
		});
		expect(res.status).toBe(409);
		expect((await res.json()).error.code).toBe('REPO_SETUP_IN_PROGRESS');
		await db.query(`UPDATE repos SET setup_status = 'failed' WHERE id = $1`, [failedRepoId]);
	});

	it('retrying a failed repo reclaims the same row and re-runs setup', async () => {
		const res = await postRepo({
			mode: 'link',
			url: 'sim-user/existing-repo',
			oauth_connection_id: connId,
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.id).toBe(failedRepoId);
		expect(body.data.setup_status).toBe('pending');

		await waitForBackground();

		const rows = await db.query<{ setup_status: string }>(
			`SELECT setup_status::text AS setup_status FROM repos
			 WHERE project_id = $1 AND repo_identifier = 'sim-user/existing-repo'`,
			[projectId],
		);
		// Still exactly one row — the retry reused it (and failed again under the
		// harness, which is fine: the point is the lifecycle, not the clone).
		expect(rows.rows).toHaveLength(1);
		expect(rows.rows[0].setup_status).toBe('failed');
	});

	it('409s (REPO_NAME_TAKEN) when re-linking a repo that is already set up', async () => {
		await db.query(`UPDATE repos SET setup_status = 'ready', setup_error = NULL WHERE id = $1`, [
			failedRepoId,
		]);
		const res = await postRepo({
			mode: 'link',
			url: 'sim-user/existing-repo',
			oauth_connection_id: connId,
		});
		expect(res.status).toBe(409);
		expect((await res.json()).error.code).toBe('REPO_NAME_TAKEN');
	});
});

describe('POST repos — mode=create branches', () => {
	it('creates a new repo on GitHub then parks the row failed under the harness', async () => {
		// The GitHub-side create succeeds (sim); the in-container clone fails under
		// the harness, so the background setup settles the row to failed and it
		// persists for a retry.
		const res = await postRepo({
			mode: 'create',
			owner: 'sim-user',
			name: 'brand-new-repo',
			private: true,
			oauth_connection_id: connId,
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.repo_identifier).toBe('sim-user/brand-new-repo');
		expect(body.data.setup_status).toBe('pending');
		// The repo was actually created on GitHub (the sim).
		expect(sim.state.repos.some((r) => r.full_name === 'sim-user/brand-new-repo')).toBe(true);

		await waitForBackground();

		const row = await db.query<{ setup_status: string }>(
			`SELECT setup_status::text AS setup_status FROM repos
			 WHERE project_id = $1 AND repo_identifier = 'sim-user/brand-new-repo'`,
			[projectId],
		);
		expect(row.rows[0].setup_status).toBe('failed');
	});

	it('409s when the repo already exists on GitHub', async () => {
		const res = await postRepo({
			mode: 'create',
			owner: 'sim-user',
			name: 'existing-repo',
			private: true,
			oauth_connection_id: connId,
		});
		expect(res.status).toBe(409);
		expect((await res.json()).error.code).toBe('GITHUB_REPO_EXISTS');
	});
});

describe('DELETE repos branches', () => {
	it('404s when the project does not resolve', async () => {
		const res = await app.request(
			`/api/projects/no-such-project/repos/00000000-0000-0000-0000-000000000000`,
			{ method: 'DELETE', headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
	});

	it('refuses to delete the designated repo (409)', async () => {
		const inserted = await db.query<{ id: string }>(
			`INSERT INTO repos (project_id, repo_identifier, host_type)
			 VALUES ($1, 'acme/designated', 'github') RETURNING id`,
			[projectId],
		);
		const repoId = inserted.rows[0].id;
		await db.query('UPDATE projects SET designated_repo_id = $1 WHERE id = $2', [
			repoId,
			projectId,
		]);

		const res = await app.request(`/api/projects/${projectId}/repos/${repoId}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(409);
		expect((await res.json()).error.code).toBe('DESIGNATED_REPO_IMMUTABLE');

		// Reset so it doesn't block other teardown.
		await db.query('UPDATE projects SET designated_repo_id = NULL WHERE id = $1', [projectId]);
		await db.query('DELETE FROM repos WHERE id = $1', [repoId]);
	});

	it('deletes a non-designated repo', async () => {
		const inserted = await db.query<{ id: string }>(
			`INSERT INTO repos (project_id, repo_identifier, host_type)
			 VALUES ($1, 'acme/removable', 'github') RETURNING id`,
			[projectId],
		);
		const res = await app.request(`/api/projects/${projectId}/repos/${inserted.rows[0].id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.deleted).toBe(true);
	});

	it('404s deleting a repo that belongs to no project row', async () => {
		const res = await app.request(
			`/api/projects/${projectId}/repos/00000000-0000-0000-0000-000000000000`,
			{ method: 'DELETE', headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
	});
});

describe('oauth-connections org/repo listing branches', () => {
	it('lists orgs for the connection', async () => {
		sim.seed({ orgs: [{ login: 'acme-org', avatar_url: '' }] });
		const res = await app.request(`/api/projects/${projectId}/oauth-connections/${connId}/orgs`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		// Personal account + the org.
		expect(body.data.some((o: { login: string }) => o.login === 'acme-org')).toBe(true);
		expect(body.data.some((o: { is_personal: boolean }) => o.is_personal)).toBe(true);
	});

	it('404s orgs listing for an unknown connection', async () => {
		const res = await app.request(
			`/api/projects/${projectId}/oauth-connections/00000000-0000-0000-0000-000000000000/orgs`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
	});

	it('requires owner query param for repo listing', async () => {
		const res = await app.request(`/api/projects/${projectId}/oauth-connections/${connId}/repos`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('INVALID_REQUEST');
	});

	it('404s repo listing for an unknown connection', async () => {
		const res = await app.request(
			`/api/projects/${projectId}/oauth-connections/00000000-0000-0000-0000-000000000000/repos?owner=sim-user`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
	});

	it('lists accessible repos for the owner', async () => {
		const res = await app.request(
			`/api/projects/${projectId}/oauth-connections/${connId}/repos?owner=sim-user`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.some((r: { name: string }) => r.name === 'existing-repo')).toBe(true);
	});

	it('filters repo listing by the q query param', async () => {
		const res = await app.request(
			`/api/projects/${projectId}/oauth-connections/${connId}/repos?owner=sim-user&q=brand`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.every((r: { name: string }) => r.name.includes('brand'))).toBe(true);
	});
});

describe('GET repos list', () => {
	it('404s when the project does not resolve', async () => {
		const res = await app.request('/api/projects/no-such-project/repos', {
			headers: authHeader(token),
		});
		expect(res.status).toBe(404);
	});

	it('lists the project repos with designation flag', async () => {
		const res = await app.request(`/api/projects/${projectId}/repos`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(Array.isArray(body.data)).toBe(true);
		expect(
			body.data.some(
				(r: { repo_identifier: string }) => r.repo_identifier === 'sim-user/existing-repo',
			),
		).toBe(true);
	});
});
