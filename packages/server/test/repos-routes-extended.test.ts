import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';
import { createGitHubSim, type GitHubSim } from './helpers/github-sim';

/**
 * Extends repos-create-github.test.ts with the request-validation branches and
 * the org/repo listing endpoints in routes/repos.ts that the happy-path tests
 * don't exercise: mode validation, OAuth-connection resolution failures, token
 * availability, REPO_NOT_ACCESSIBLE, and the two GitHub list proxies — all
 * driven against the local GitHub simulator.
 */

let app: Hono<Env>;
let db: Db;
let masterKeyManager: MasterKeyManager;
let token: string;
let teamId: string;
let projectId: string;
let githubConnId: string;
let nonGithubConnId: string;
let sim: GitHubSim;

let prevApi: string | undefined;
const accessToken = 'gho_repos_ext_token';

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
		user: { id: 9001, login: 'octo-ext', avatar_url: 'http://a/u', email: 'octo@e2e' },
		orgs: [{ login: 'acme-org', avatar_url: 'http://a/o' }],
		repos: [
			{
				id: 1,
				name: 'visible-repo',
				full_name: 'octo-ext/visible-repo',
				owner: { login: 'octo-ext' },
				private: false,
				default_branch: 'main',
				clone_url: 'https://github.com/octo-ext/visible-repo.git',
				ssh_url: 'git@github.com:octo-ext/visible-repo.git',
			},
			{
				id: 2,
				name: 'org-repo',
				full_name: 'acme-org/org-repo',
				owner: { login: 'acme-org' },
				private: true,
				default_branch: 'main',
				clone_url: 'https://github.com/acme-org/org-repo.git',
				ssh_url: 'git@github.com:acme-org/org-repo.git',
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
		(t: { name: string }) => t.name === 'App Team',
	).id;
	const teamRes = await createTestTeam(db, { name: 'Repos Ext Co', template_id: typeId });
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, { name: 'Repos Ext Project' });
	projectId = (await projectRes.json()).data.id;

	githubConnId = await seedGitHubOAuthConnection('octo-ext');

	// A non-GitHub oauth connection to exercise the provider mismatch branch.
	const secretRes = await db.query<{ id: string }>(
		`INSERT INTO secrets (name, encrypted_value) VALUES ('OAUTH_OTHER_X', 'enc') RETURNING id`,
	);
	const otherConn = await db.query<{ id: string }>(
		`INSERT INTO oauth_connections (provider, provider_account_id, provider_account_label, access_token_secret_id)
		 VALUES ('gitlab', 'acct', 'Other', $1) RETURNING id`,
		[secretRes.rows[0].id],
	);
	nonGithubConnId = otherConn.rows[0].id;
});

afterAll(async () => {
	process.env.GITHUB_API_BASE_URL = prevApi;
	await sim.destroy();
	await safeClose(db);
});

describe('POST /repos request validation', () => {
	const post = (body: unknown) =>
		app.request(`/api/projects/${projectId}/repos`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});

	it('rejects an unknown mode', async () => {
		const res = await post({ mode: 'fork', oauth_connection_id: githubConnId });
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('mode must be');
	});

	it('rejects mode=create missing owner/name', async () => {
		const res = await post({ mode: 'create', oauth_connection_id: githubConnId });
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('owner and name are required');
	});

	it('rejects a link request missing oauth_connection_id', async () => {
		const res = await post({ mode: 'link', url: 'https://github.com/octo-ext/visible-repo' });
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('oauth_connection_id is required');
	});

	it('returns 404 for an unknown oauth_connection_id', async () => {
		const res = await post({
			mode: 'link',
			url: 'https://github.com/octo-ext/visible-repo',
			oauth_connection_id: '00000000-0000-0000-0000-000000000000',
		});
		expect(res.status).toBe(404);
		expect((await res.json()).error.message).toContain('oauth connection not found');
	});

	it('rejects a non-GitHub oauth connection', async () => {
		const res = await post({
			mode: 'link',
			url: 'https://github.com/octo-ext/visible-repo',
			oauth_connection_id: nonGithubConnId,
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('not for GitHub');
	});

	it('returns 403 REPO_NOT_ACCESSIBLE when the token cannot reach the repo', async () => {
		const res = await post({
			mode: 'link',
			url: 'https://github.com/octo-ext/does-not-exist',
			oauth_connection_id: githubConnId,
		});
		expect(res.status).toBe(403);
		const body = await res.json();
		expect(body.error.code).toBe('REPO_NOT_ACCESSIBLE');
		expect(body.error.message).toContain('octo-ext/does-not-exist');
	});
});

describe('GET /oauth-connections/:id/orgs', () => {
	it('lists the personal account plus orgs', async () => {
		const res = await app.request(
			`/api/projects/${projectId}/oauth-connections/${githubConnId}/orgs`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const orgs = (await res.json()).data as Array<{ login: string; is_personal: boolean }>;
		expect(orgs.find((o) => o.login === 'octo-ext')?.is_personal).toBe(true);
		expect(orgs.some((o) => o.login === 'acme-org')).toBe(true);
	});

	it('returns 404 for a non-GitHub connection', async () => {
		const res = await app.request(
			`/api/projects/${projectId}/oauth-connections/${nonGithubConnId}/orgs`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
	});
});

describe('GET /oauth-connections/:id/repos', () => {
	it('requires the owner query parameter', async () => {
		const res = await app.request(
			`/api/projects/${projectId}/oauth-connections/${githubConnId}/repos`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('owner query parameter is required');
	});

	it('lists the authenticated user own repos', async () => {
		const res = await app.request(
			`/api/projects/${projectId}/oauth-connections/${githubConnId}/repos?owner=octo-ext`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const repos = (await res.json()).data as Array<{ name: string }>;
		expect(repos.some((r) => r.name === 'visible-repo')).toBe(true);
	});

	it('lists org repos and honours the q filter', async () => {
		const res = await app.request(
			`/api/projects/${projectId}/oauth-connections/${githubConnId}/repos?owner=acme-org&q=org`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const repos = (await res.json()).data as Array<{ name: string }>;
		expect(repos.some((r) => r.name === 'org-repo')).toBe(true);

		const noMatch = await app.request(
			`/api/projects/${projectId}/oauth-connections/${githubConnId}/repos?owner=acme-org&q=zzz`,
			{ headers: authHeader(token) },
		);
		expect(((await noMatch.json()).data as unknown[]).length).toBe(0);
	});

	it('returns 404 for a non-GitHub connection', async () => {
		const res = await app.request(
			`/api/projects/${projectId}/oauth-connections/${nonGithubConnId}/repos?owner=octo-ext`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
	});
});
