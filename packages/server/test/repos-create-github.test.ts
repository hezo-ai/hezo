import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject } from './helpers/app';
import { createGitHubSim, type GitHubSim } from './helpers/github-sim';

let app: Hono<Env>;
let db: PGlite;
let masterKeyManager: MasterKeyManager;
let token: string;
let teamId: string;
let projectId: string;
let oauthConnectionId: string;
let sim: GitHubSim;

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
		],
	});

	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	masterKeyManager = ctx.masterKeyManager;
	token = ctx.token;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: { name: string }) => t.name === 'Startup',
	).id;
	const teamRes = await app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Repo Create Co', template_id: typeId }),
	});
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
				short_name: 'collision',
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
});
