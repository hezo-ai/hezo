import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import { waitForBackground } from '../src/lib/background';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';
import { createGitHubSim, type GitHubSim } from './helpers/github-sim';

let app: Hono<Env>;
let db: Db;
let masterKeyManager: MasterKeyManager;
let token: string;
let teamId: string;
let projectId: string;
let oauthConnectionId: string;
let sim: GitHubSim;
let dataDir: string;

let prevApi: string | undefined;
const accessToken = 'gho_repo_create_test_token';

async function seedGitHubOAuthConnection(login: string): Promise<string> {
	const { encrypt } = await import('../src/crypto/encryption');
	const key = masterKeyManager.getKey();
	if (!key) throw new Error('master key not available');
	const encrypted = encrypt(accessToken, key);

	const secretRes = await db.query<{ id: string }>(
		`INSERT INTO secrets (name, encrypted_value, category, allowed_hosts)
		 VALUES ($1, $2, 'api_token', ARRAY['github.com'])
		 RETURNING id`,
		[`OAUTH_GITHUB_${Math.random().toString(16).slice(2, 10)}`, encrypted],
	);
	const connRes = await db.query<{ id: string }>(
		`INSERT INTO oauth_connections (provider, provider_account_id, provider_account_label, access_token_secret_id, scopes)
		 VALUES ('github', $1, $2, $3, ARRAY['repo','read:org'])
		 RETURNING id`,
		['9001', login, secretRes.rows[0].id],
	);
	return connRes.rows[0].id;
}

beforeAll(async () => {
	sim = await createGitHubSim();
	prevApi = process.env.GITHUB_API_BASE_URL;
	process.env.GITHUB_API_BASE_URL = sim.baseUrl;

	sim.seed({
		token: accessToken,
		user: { id: 9001, login: 'octo-repo', avatar_url: '', email: 'octo@e2e' },
		repos: [
			{
				id: 555,
				name: 'already-taken',
				full_name: 'octo-repo/already-taken',
				owner: { login: 'octo-repo' },
				private: true,
				default_branch: 'main',
				clone_url: 'https://github.com/octo-repo/already-taken.git',
				ssh_url: 'git@github.com:octo-repo/already-taken.git',
			},
			{
				id: 556,
				name: 'already-public',
				full_name: 'octo-repo/already-public',
				owner: { login: 'octo-repo' },
				private: false,
				default_branch: 'main',
				clone_url: 'https://github.com/octo-repo/already-public.git',
				ssh_url: 'git@github.com:octo-repo/already-public.git',
			},
		],
	});

	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	masterKeyManager = ctx.masterKeyManager;
	token = ctx.token;
	dataDir = ctx.dataDir;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: { name: string }) => t.name === 'App Team',
	).id;
	const teamRes = await createTestTeam(db, { name: 'Repo Create Co', template_id: typeId });
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, { name: 'Repo Create Project' });
	projectId = (await projectRes.json()).data.id;

	oauthConnectionId = await seedGitHubOAuthConnection('octo-repo');
});

afterAll(async () => {
	process.env.GITHUB_API_BASE_URL = prevApi;
	await sim.destroy();
	await safeClose(db);
});

describe('POST /api/projects/:projectId/repos with mode=create', () => {
	it('returns 409 GITHUB_REPO_EXISTS when the name is already taken on GitHub', async () => {
		const res = await app.request(`/api/projects/${projectId}/repos`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				mode: 'create',
				owner: 'octo-repo',
				name: 'already-taken',
				private: true,
				oauth_connection_id: oauthConnectionId,
			}),
		});
		expect(res.status).toBe(409);
		const body = await res.json();
		expect(body.error.code).toBe('GITHUB_REPO_EXISTS');
		expect(body.error.message).toContain('octo-repo/already-taken');
		expect(body.error.message).toContain('already exists');
		expect(body.error.message).not.toMatch(/^Failed to create GitHub repo/);

		const repoRows = await db.query<{ id: string }>('SELECT id FROM repos WHERE project_id = $1', [
			projectId,
		]);
		expect(repoRows.rows).toHaveLength(0);
	});

	it('names the existing repo as private, which is why the picker never showed it', async () => {
		// The case that actually confuses people: the name is held by a repo they
		// cannot see, so "create" looks like the only option and the collision reads
		// as a bug in Hezo. "Already exists" alone is the least useful true thing to
		// say about it.
		const res = await app.request(`/api/projects/${projectId}/repos`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				mode: 'create',
				owner: 'octo-repo',
				name: 'already-taken',
				private: false,
				oauth_connection_id: oauthConnectionId,
			}),
		});
		expect(res.status).toBe(409);
		const message = (await res.json()).error.message as string;
		expect(message).toContain('It is private');
		expect(message).toContain('repository picker');
		// And it says what to do instead of only what went wrong.
		expect(message).toContain('Link that repository instead');
	});

	it('says so plainly when the existing repo is public', async () => {
		const res = await app.request(`/api/projects/${projectId}/repos`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				mode: 'create',
				owner: 'octo-repo',
				name: 'already-public',
				private: true,
				oauth_connection_id: oauthConnectionId,
			}),
		});
		expect(res.status).toBe(409);
		const message = (await res.json()).error.message as string;
		expect(message).toContain('It is public');
		expect(message).not.toContain('It is private');
	});

	it('refuses before creating anything, rather than reading it off the failure', async () => {
		// The 422 path still exists as the race backstop, but it depends on GitHub's
		// error prose still matching and can say nothing about what is in the way.
		// Asking first is what makes the answer deterministic - and it is why no
		// POST reaches the create endpoint at all.
		const before = sim.state.repos.length;
		const res = await app.request(`/api/projects/${projectId}/repos`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				mode: 'create',
				owner: 'octo-repo',
				name: 'already-taken',
				private: true,
				oauth_connection_id: oauthConnectionId,
			}),
		});
		expect(res.status).toBe(409);
		expect(sim.state.repos.length).toBe(before);
	});
});

// POST /repos clones over SSH after the insert; the test app has no
// SshAgentServer, so emulate an existing clone (repo-sync skips dirs that
// already contain .git) to keep the success path quiet and deterministic.
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

describe('repo creation, first-repo designation, and designated immutability', () => {
	let designatedRepoId: string;
	let secondRepoId: string;

	it('mode=create creates the repo on GitHub and auto-designates the first repo', async () => {
		// Container already "running" so the post-designation auto-start is a no-op.
		await db.query(
			`UPDATE projects SET container_id = 'test-container', container_status = 'running' WHERE id = $1`,
			[projectId],
		);
		fakeClonedRepoDir('fresh-service');

		const res = await app.request(`/api/projects/${projectId}/repos`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				mode: 'create',
				owner: 'octo-repo',
				name: 'fresh-service',
				private: true,
				oauth_connection_id: oauthConnectionId,
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.repo_identifier).toBe('octo-repo/fresh-service');
		// Checkout + designation settle in the background after the response.
		expect(body.data.setup_status).toBe('pending');
		expect(body.data.is_designated).toBe(false);
		designatedRepoId = body.data.id;

		// Created upstream, not just recorded locally.
		expect(sim.state.repos.some((r) => r.full_name === 'octo-repo/fresh-service')).toBe(true);

		await waitForBackground();

		const repoRow = await db.query<{ setup_status: string }>(
			`SELECT setup_status::text AS setup_status FROM repos WHERE id = $1`,
			[designatedRepoId],
		);
		expect(repoRow.rows[0].setup_status).toBe('ready');

		const project = await db.query<{ designated_repo_id: string | null }>(
			'SELECT designated_repo_id FROM projects WHERE id = $1',
			[projectId],
		);
		expect(project.rows[0].designated_repo_id).toBe(designatedRepoId);
	});

	it('mode=link adds a second repo without re-designating', async () => {
		fakeClonedRepoDir('already-taken');

		const res = await app.request(`/api/projects/${projectId}/repos`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				mode: 'link',
				url: 'https://github.com/octo-repo/already-taken',
				oauth_connection_id: oauthConnectionId,
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.is_designated).toBe(false);
		secondRepoId = body.data.id;

		await waitForBackground();

		const project = await db.query<{ designated_repo_id: string | null }>(
			'SELECT designated_repo_id FROM projects WHERE id = $1',
			[projectId],
		);
		expect(project.rows[0].designated_repo_id).toBe(designatedRepoId);
	});

	it('DELETE on the designated repo returns 409 DESIGNATED_REPO_IMMUTABLE', async () => {
		const res = await app.request(`/api/projects/${projectId}/repos/${designatedRepoId}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(409);
		const body = await res.json();
		expect(body.error.code).toBe('DESIGNATED_REPO_IMMUTABLE');

		const still = await db.query('SELECT id FROM repos WHERE id = $1', [designatedRepoId]);
		expect(still.rows).toHaveLength(1);
	});

	it('DELETE on a non-designated repo still works', async () => {
		const res = await app.request(`/api/projects/${projectId}/repos/${secondRepoId}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.deleted).toBe(true);
	});
});
