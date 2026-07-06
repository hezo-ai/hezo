import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

const accessToken = 'gho_covfill_token';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

let connSeq = 0;
async function seedOAuthConnection(opts: {
	provider?: string;
	tokenValue?: string;
}): Promise<string> {
	connSeq += 1;
	const { encrypt } = await import('../src/crypto/encryption');
	const key = masterKeyManager.getKey();
	if (!key) throw new Error('master key not available');
	const encrypted = encrypt(opts.tokenValue ?? accessToken, key);
	const secret = await db.query<{ id: string }>(
		`INSERT INTO secrets (name, encrypted_value, category, allowed_hosts)
		 VALUES ($1, $2, 'api_token', ARRAY['github.com']) RETURNING id`,
		[`COVFILL_OAUTH_${connSeq}`, encrypted],
	);
	const conn = await db.query<{ id: string }>(
		`INSERT INTO oauth_connections (provider, provider_account_id, provider_account_label, access_token_secret_id, scopes)
		 VALUES ($1, $2, 'Covfill Owner', $3, ARRAY['repo','read:org']) RETURNING id`,
		[opts.provider ?? 'github', `acct-${connSeq}`, secret.rows[0].id],
	);
	return conn.rows[0].id;
}

function postRepo(body: unknown) {
	return app.request(`/api/projects/${projectId}/repos`, {
		method: 'POST',
		headers: { ...authHeader(token), ...JSON_HEADERS },
		body: JSON.stringify(body),
	});
}

async function errorCode(res: Response): Promise<string> {
	return ((await res.json()) as { error: { code: string } }).error.code;
}

// POST /repos clones over SSH in the background; the test app has no
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

beforeAll(async () => {
	sim = await createGitHubSim();
	prevApi = process.env.GITHUB_API_BASE_URL;
	process.env.GITHUB_API_BASE_URL = sim.baseUrl;

	sim.seed({
		token: accessToken,
		user: { id: 7001, login: 'covfill-owner', avatar_url: '', email: 'covfill@e2e' },
		orgs: [{ login: 'covfill-org', avatar_url: '' }],
		repos: [
			{
				id: 701,
				name: 'linked-repo',
				full_name: 'covfill-owner/linked-repo',
				owner: { login: 'covfill-owner' },
				private: true,
				default_branch: 'main',
				clone_url: 'https://github.com/covfill-owner/linked-repo.git',
				ssh_url: 'git@github.com:covfill-owner/linked-repo.git',
			},
			{
				id: 702,
				name: 'taken-name',
				full_name: 'covfill-owner/taken-name',
				owner: { login: 'covfill-owner' },
				private: true,
				default_branch: 'main',
				clone_url: 'https://github.com/covfill-owner/taken-name.git',
				ssh_url: 'git@github.com:covfill-owner/taken-name.git',
			},
			{
				id: 703,
				name: 'linked-repo',
				full_name: 'other-owner/linked-repo',
				owner: { login: 'other-owner' },
				private: true,
				default_branch: 'main',
				clone_url: 'https://github.com/other-owner/linked-repo.git',
				ssh_url: 'git@github.com:other-owner/linked-repo.git',
			},
		],
	});

	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	masterKeyManager = ctx.masterKeyManager;
	token = ctx.token;
	dataDir = ctx.dataDir;

	const teamRes = await createTestTeam(db, { name: 'Repos Covfill Co' });
	teamId = (await teamRes.json()).data.id;
	const projectRes = await createTestProject(db, teamId, { name: 'Repos Covfill Project' });
	projectId = (await projectRes.json()).data.id;

	oauthConnectionId = await seedOAuthConnection({});
});

afterAll(async () => {
	process.env.GITHUB_API_BASE_URL = prevApi;
	await sim.destroy();
	await safeClose(db);
});

describe('GET /api/projects/:projectId/repos', () => {
	it('returns an empty list before any repo is linked', async () => {
		const res = await app.request(`/api/projects/${projectId}/repos`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data).toEqual([]);
	});
});

describe('POST /api/projects/:projectId/repos — validation and upstream failures', () => {
	it('rejects mode=link without a url', async () => {
		const res = await postRepo({ mode: 'link', oauth_connection_id: oauthConnectionId });
		expect(res.status).toBe(400);
		expect(await errorCode(res)).toBe('INVALID_REQUEST');
	});

	it('rejects an unparseable GitHub url', async () => {
		const res = await postRepo({
			mode: 'link',
			url: 'https://example.com/not/a/github/repo/url',
			oauth_connection_id: oauthConnectionId,
		});
		expect(res.status).toBe(400);
		expect(await errorCode(res)).toBe('INVALID_URL');
	});

	it('rejects mode=create without owner or name', async () => {
		for (const body of [
			{ mode: 'create', name: 'x', oauth_connection_id: oauthConnectionId },
			{ mode: 'create', owner: 'covfill-owner', oauth_connection_id: oauthConnectionId },
		]) {
			const res = await postRepo(body);
			expect(res.status).toBe(400);
			expect(await errorCode(res)).toBe('INVALID_REQUEST');
		}
	});

	it('rejects an unknown mode', async () => {
		const res = await postRepo({ mode: 'fork', oauth_connection_id: oauthConnectionId });
		expect(res.status).toBe(400);
		expect(await errorCode(res)).toBe('INVALID_REQUEST');
	});

	it('rejects a missing oauth_connection_id', async () => {
		const res = await postRepo({
			mode: 'link',
			url: 'https://github.com/covfill-owner/linked-repo',
		});
		expect(res.status).toBe(400);
		expect(await errorCode(res)).toBe('INVALID_REQUEST');
	});

	it('404s on an unknown oauth connection', async () => {
		const res = await postRepo({
			mode: 'link',
			url: 'https://github.com/covfill-owner/linked-repo',
			oauth_connection_id: '00000000-0000-0000-0000-000000000000',
		});
		expect(res.status).toBe(404);
		expect(await errorCode(res)).toBe('NOT_FOUND');
	});

	it('rejects a non-GitHub oauth connection', async () => {
		const gitlabConn = await seedOAuthConnection({ provider: 'gitlab' });
		const res = await postRepo({
			mode: 'link',
			url: 'https://github.com/covfill-owner/linked-repo',
			oauth_connection_id: gitlabConn,
		});
		expect(res.status).toBe(400);
		expect(await errorCode(res)).toBe('INVALID_REQUEST');
	});

	it('503s when the master key is unavailable to decrypt the token', async () => {
		const spy = vi.spyOn(masterKeyManager, 'getKey').mockReturnValue(null);
		try {
			const res = await postRepo({
				mode: 'link',
				url: 'https://github.com/covfill-owner/linked-repo',
				oauth_connection_id: oauthConnectionId,
			});
			expect(res.status).toBe(503);
			expect(await errorCode(res)).toBe('OAUTH_TOKEN_UNAVAILABLE');
		} finally {
			spy.mockRestore();
		}
	});

	it('403s REPO_NOT_ACCESSIBLE when the token cannot see the repo', async () => {
		const res = await postRepo({
			mode: 'link',
			url: 'https://github.com/covfill-owner/no-such-repo',
			oauth_connection_id: oauthConnectionId,
		});
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe('REPO_NOT_ACCESSIBLE');
		expect(body.error.message).toContain('covfill-owner/no-such-repo');
		// Nothing recorded.
		const rows = await db.query('SELECT id FROM repos WHERE project_id = $1', [projectId]);
		expect(rows.rows).toHaveLength(0);
	});

	it('500s REPO_CREATE_FAILED when GitHub rejects the create call', async () => {
		const badConn = await seedOAuthConnection({ tokenValue: 'gho_not_a_real_token' });
		const res = await postRepo({
			mode: 'create',
			owner: 'covfill-owner',
			name: 'never-created',
			oauth_connection_id: badConn,
		});
		expect(res.status).toBe(500);
		expect(await errorCode(res)).toBe('REPO_CREATE_FAILED');
		expect(sim.state.repos.some((r) => r.name === 'never-created')).toBe(false);
	});

	it('409s GITHUB_REPO_EXISTS when the name is taken upstream', async () => {
		const res = await postRepo({
			mode: 'create',
			owner: 'covfill-owner',
			name: 'taken-name',
			oauth_connection_id: oauthConnectionId,
		});
		expect(res.status).toBe(409);
		expect(await errorCode(res)).toBe('GITHUB_REPO_EXISTS');
	});
});

describe('repo lifecycle: link, duplicates, reclaim, delete', () => {
	let firstRepoId: string;

	it('links a repo, returns it pending, and settles it ready in the background', async () => {
		// Container already "running" so the post-designation auto-start is a no-op.
		await db.query(
			`UPDATE projects SET container_id = 'covfill-container', container_status = 'running' WHERE id = $1`,
			[projectId],
		);
		fakeClonedRepoDir('linked-repo');

		const res = await postRepo({
			mode: 'link',
			url: 'https://github.com/covfill-owner/linked-repo',
			oauth_connection_id: oauthConnectionId,
		});
		expect(res.status).toBe(201);
		const body = (await res.json()).data as {
			id: string;
			repo_identifier: string;
			setup_status: string;
			is_designated: boolean;
		};
		expect(body.repo_identifier).toBe('covfill-owner/linked-repo');
		expect(body.setup_status).toBe('pending');
		expect(body.is_designated).toBe(false);
		firstRepoId = body.id;

		await waitForBackground();
		const row = await db.query<{ setup_status: string }>(
			'SELECT setup_status::text AS setup_status FROM repos WHERE id = $1',
			[firstRepoId],
		);
		expect(row.rows[0].setup_status).toBe('ready');

		// GET now lists it, designated as the first repo.
		const list = await app.request(`/api/projects/${projectId}/repos`, {
			headers: authHeader(token),
		});
		const rows = (await list.json()).data as Array<{ id: string; is_designated: boolean }>;
		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe(firstRepoId);
		expect(rows[0].is_designated).toBe(true);
	});

	it('409s REPO_NAME_TAKEN when re-linking a ready repo', async () => {
		const res = await postRepo({
			mode: 'link',
			url: 'https://github.com/covfill-owner/linked-repo',
			oauth_connection_id: oauthConnectionId,
		});
		expect(res.status).toBe(409);
		expect(await errorCode(res)).toBe('REPO_NAME_TAKEN');
	});

	it('409s REPO_NAME_TAKEN for the same repo name under a different owner', async () => {
		const res = await postRepo({
			mode: 'link',
			url: 'https://github.com/other-owner/linked-repo',
			oauth_connection_id: oauthConnectionId,
		});
		expect(res.status).toBe(409);
		expect(await errorCode(res)).toBe('REPO_NAME_TAKEN');
	});

	it('409s REPO_SETUP_IN_PROGRESS while the existing row is pending', async () => {
		await db.query(`UPDATE repos SET setup_status = 'pending'::repo_setup_status WHERE id = $1`, [
			firstRepoId,
		]);
		const res = await postRepo({
			mode: 'link',
			url: 'https://github.com/covfill-owner/linked-repo',
			oauth_connection_id: oauthConnectionId,
		});
		expect(res.status).toBe(409);
		expect(await errorCode(res)).toBe('REPO_SETUP_IN_PROGRESS');
	});

	it('reclaims a failed row on retry and re-runs setup', async () => {
		await db.query(
			`UPDATE repos SET setup_status = 'failed'::repo_setup_status, setup_error = 'clone failed' WHERE id = $1`,
			[firstRepoId],
		);
		const res = await postRepo({
			mode: 'link',
			url: 'https://github.com/covfill-owner/linked-repo',
			oauth_connection_id: oauthConnectionId,
		});
		expect(res.status).toBe(201);
		const body = (await res.json()).data as { id: string; setup_status: string };
		expect(body.id).toBe(firstRepoId);
		expect(body.setup_status).toBe('pending');

		await waitForBackground();
		const row = await db.query<{ setup_status: string; setup_error: string | null }>(
			'SELECT setup_status::text AS setup_status, setup_error FROM repos WHERE id = $1',
			[firstRepoId],
		);
		expect(row.rows[0].setup_status).toBe('ready');
		expect(row.rows[0].setup_error).toBeNull();
	});

	it('refuses to delete the designated repo', async () => {
		const res = await app.request(`/api/projects/${projectId}/repos/${firstRepoId}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(409);
		expect(await errorCode(res)).toBe('DESIGNATED_REPO_IMMUTABLE');
	});

	it('404s deleting an unknown repo', async () => {
		const res = await app.request(
			`/api/projects/${projectId}/repos/00000000-0000-0000-0000-000000000000`,
			{ method: 'DELETE', headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
		expect(await errorCode(res)).toBe('NOT_FOUND');
	});

	it('deletes a non-designated repo and cleans up its workspace checkout', async () => {
		fakeClonedRepoDir('taken-name');
		const created = await postRepo({
			mode: 'link',
			url: 'https://github.com/covfill-owner/taken-name',
			oauth_connection_id: oauthConnectionId,
		});
		expect(created.status).toBe(201);
		const repoId = ((await created.json()).data as { id: string }).id;
		await waitForBackground();

		const checkout = join(
			dataDir,
			'teams',
			teamId,
			'projects',
			projectId,
			'workspace',
			'taken-name',
		);
		expect(existsSync(checkout)).toBe(true);

		const res = await app.request(`/api/projects/${projectId}/repos/${repoId}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.deleted).toBe(true);
		const rows = await db.query('SELECT id FROM repos WHERE id = $1', [repoId]);
		expect(rows.rows).toHaveLength(0);
		expect(existsSync(checkout)).toBe(false);
	});
});

describe('GET oauth-connections/:id/orgs and /repos', () => {
	it('404s for an unknown or non-GitHub connection', async () => {
		const unknownOrgs = await app.request(
			`/api/projects/${projectId}/oauth-connections/00000000-0000-0000-0000-000000000000/orgs`,
			{ headers: authHeader(token) },
		);
		expect(unknownOrgs.status).toBe(404);

		const gitlabConn = await seedOAuthConnection({ provider: 'gitlab' });
		const wrongProvider = await app.request(
			`/api/projects/${projectId}/oauth-connections/${gitlabConn}/repos?owner=x`,
			{ headers: authHeader(token) },
		);
		expect(wrongProvider.status).toBe(404);
	});

	it('503s when the key is unavailable', async () => {
		const spy = vi.spyOn(masterKeyManager, 'getKey').mockReturnValue(null);
		try {
			const orgs = await app.request(
				`/api/projects/${projectId}/oauth-connections/${oauthConnectionId}/orgs`,
				{ headers: authHeader(token) },
			);
			expect(orgs.status).toBe(503);
			expect(await errorCode(orgs)).toBe('OAUTH_TOKEN_UNAVAILABLE');

			const repos = await app.request(
				`/api/projects/${projectId}/oauth-connections/${oauthConnectionId}/repos?owner=covfill-owner`,
				{ headers: authHeader(token) },
			);
			expect(repos.status).toBe(503);
		} finally {
			spy.mockRestore();
		}
	});

	it('lists orgs including the personal account', async () => {
		const res = await app.request(
			`/api/projects/${projectId}/oauth-connections/${oauthConnectionId}/orgs`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const orgs = (await res.json()).data as Array<{ login: string; is_personal: boolean }>;
		expect(orgs.find((o) => o.login === 'covfill-owner')?.is_personal).toBe(true);
		expect(orgs.find((o) => o.login === 'covfill-org')?.is_personal).toBe(false);
	});

	it('requires an owner param for the repo listing', async () => {
		const res = await app.request(
			`/api/projects/${projectId}/oauth-connections/${oauthConnectionId}/repos`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(400);
		expect(await errorCode(res)).toBe('INVALID_REQUEST');
	});

	it('lists accessible repos for an owner, filtered by q', async () => {
		const all = await app.request(
			`/api/projects/${projectId}/oauth-connections/${oauthConnectionId}/repos?owner=covfill-owner`,
			{ headers: authHeader(token) },
		);
		expect(all.status).toBe(200);
		const rows = (await all.json()).data as Array<{ name: string }>;
		expect(rows.map((r) => r.name)).toContain('linked-repo');
		expect(rows.map((r) => r.name)).toContain('taken-name');

		const filtered = await app.request(
			`/api/projects/${projectId}/oauth-connections/${oauthConnectionId}/repos?owner=covfill-owner&q=taken`,
			{ headers: authHeader(token) },
		);
		const filteredRows = (await filtered.json()).data as Array<{ name: string }>;
		expect(filteredRows.map((r) => r.name)).toEqual(['taken-name']);
	});
});
