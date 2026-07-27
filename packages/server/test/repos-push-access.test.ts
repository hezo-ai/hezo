import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import { waitForBackground } from '../src/lib/background';
import type { Env } from '../src/lib/types';
import { performRepoSetup } from '../src/services/repo-provisioning';
import { refreshRepoPushAccess } from '../src/services/repo-push-access';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';
import { createGitHubSim, type GitHubSim } from './helpers/github-sim';

/**
 * Linking a repo only ever proved *read* access — a 200 from the repo endpoint,
 * which a read-only collaborator also gets. These cover the write signal that
 * makes the difference between "linked" and "an agent's push will actually
 * land": recorded at link time, refreshed whenever the server holds the token,
 * and never guessed when the answer is unknown.
 */

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
const accessToken = 'gho_push_access_test_token';

const repo = (
	owner: string,
	name: string,
	permissions?: { admin: boolean; push: boolean; pull: boolean },
) => ({
	id: Math.floor(Math.random() * 100000),
	name,
	full_name: `${owner}/${name}`,
	owner: { login: owner },
	private: true,
	default_branch: 'main',
	clone_url: `https://github.com/${owner}/${name}.git`,
	ssh_url: `git@github.com:${owner}/${name}.git`,
	...(permissions ? { permissions } : {}),
});

/**
 * Linking clones over SSH, and the test app has no SshAgentServer. Emulating an
 * existing clone (repo-sync skips dirs that already carry `.git`) keeps the link
 * path quiet — a background clone failure would otherwise log an error that has
 * nothing to do with what these tests assert.
 */
const fakeClonedRepoDir = (repoName: string) => {
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
};

const linkRepo = (identifier: string) => {
	fakeClonedRepoDir(identifier.split('/')[1]);
	return app.request(`/api/projects/${projectId}/repos`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			mode: 'link',
			url: `https://github.com/${identifier}`,
			oauth_connection_id: oauthConnectionId,
		}),
	});
};

const storedCanPush = async (repoId: string): Promise<boolean | null> => {
	const res = await db.query<{ can_push: boolean | null }>(
		'SELECT can_push FROM repos WHERE id = $1',
		[repoId],
	);
	return res.rows[0]?.can_push ?? null;
};

beforeAll(async () => {
	sim = await createGitHubSim();
	prevApi = process.env.GITHUB_API_BASE_URL;
	process.env.GITHUB_API_BASE_URL = sim.baseUrl;

	sim.seed({
		token: accessToken,
		user: { id: 4242, login: 'hezo-agent', avatar_url: '', email: null },
		repos: [
			// The account owns this one outright.
			repo('hezo-agent', 'website'),
			// Linked for reference, but the account is only a read-only collaborator —
			// exactly the shape that strands a finished commit at push time.
			repo('other-org', 'product', { admin: false, push: false, pull: true }),
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
	const teamRes = await createTestTeam(db, { name: 'Push Access Co', template_id: typeId });
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, { name: 'Push Access Project' });
	projectId = (await projectRes.json()).data.id;

	const { encrypt } = await import('../src/crypto/encryption');
	const key = masterKeyManager.getKey();
	if (!key) throw new Error('master key not available');
	const secretRes = await db.query<{ id: string }>(
		`INSERT INTO secrets (name, encrypted_value, category, allowed_hosts)
		 VALUES ('OAUTH_GITHUB_PUSH_ACCESS', $1, 'api_token', ARRAY['github.com'])
		 RETURNING id`,
		[encrypt(accessToken, key)],
	);
	const connRes = await db.query<{ id: string }>(
		`INSERT INTO oauth_connections (provider, provider_account_id, provider_account_label, access_token_secret_id, scopes)
		 VALUES ('github', '4242', 'hezo-agent', $1, ARRAY['repo','read:org'])
		 RETURNING id`,
		[secretRes.rows[0].id],
	);
	oauthConnectionId = connRes.rows[0].id;
});

afterAll(async () => {
	await waitForBackground();
	process.env.GITHUB_API_BASE_URL = prevApi;
	await sim.destroy();
	await safeClose(db);
});

describe('recording push access when a repo is linked', () => {
	it('records can_push=true for a repo the connected account can write', async () => {
		const res = await linkRepo('hezo-agent/website');
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.can_push).toBe(true);
		expect(await storedCanPush(body.data.id)).toBe(true);
	});

	it('links a read-only repo rather than blocking it, and records can_push=false', async () => {
		const res = await linkRepo('other-org/product');
		// A read-only link is legitimate — agents read connected repos from disk —
		// so the write gap is recorded, not treated as a reason to refuse.
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.can_push).toBe(false);
		expect(await storedCanPush(body.data.id)).toBe(false);
	});

	it('surfaces can_push on the repo listing', async () => {
		const res = await app.request(`/api/projects/${projectId}/repos`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const rows = (await res.json()).data as Array<{
			repo_identifier: string;
			can_push: boolean | null;
		}>;
		expect(Object.fromEntries(rows.map((r) => [r.repo_identifier, r.can_push]))).toMatchObject({
			'hezo-agent/website': true,
			'other-org/product': false,
		});
	});
});

describe('refreshRepoPushAccess', () => {
	const seedRepoRow = async (identifier: string, canPush: boolean | null): Promise<string> => {
		const res = await db.query<{ id: string }>(
			`INSERT INTO repos (project_id, repo_identifier, host_type, oauth_connection_id, can_push)
			 VALUES ($1, $2, 'github'::repo_host_type, $3, $4) RETURNING id`,
			[projectId, identifier, oauthConnectionId, canPush],
		);
		return res.rows[0].id;
	};

	it('picks up write access granted on GitHub after the repo was linked', async () => {
		const repoId = await seedRepoRow('other-org/promoted', false);
		sim.state.repos.push(repo('other-org', 'promoted', { admin: false, push: true, pull: true }));

		expect(await refreshRepoPushAccess({ db, masterKeyManager }, repoId)).toBe(true);
		expect(await storedCanPush(repoId)).toBe(true);
	});

	it('picks up write access revoked on GitHub after the repo was linked', async () => {
		const repoId = await seedRepoRow('other-org/demoted', true);
		sim.state.repos.push(repo('other-org', 'demoted', { admin: false, push: false, pull: true }));

		expect(await refreshRepoPushAccess({ db, masterKeyManager }, repoId)).toBe(false);
		expect(await storedCanPush(repoId)).toBe(false);
	});

	it('records read-only when the account can no longer even see the repo', async () => {
		// 404 is definitive: an account that cannot read a repo certainly cannot
		// push to it, so this is a real answer rather than an inconclusive one.
		const repoId = await seedRepoRow('other-org/vanished', true);
		expect(await refreshRepoPushAccess({ db, masterKeyManager }, repoId)).toBe(false);
		expect(await storedCanPush(repoId)).toBe(false);
	});

	it('keeps the stored value when the check cannot reach GitHub', async () => {
		const repoId = await seedRepoRow('other-org/unreachable', true);
		const prev = process.env.GITHUB_API_BASE_URL;
		process.env.GITHUB_API_BASE_URL = 'http://127.0.0.1:1';
		try {
			// A transient network failure must not silently demote a repo to
			// read-only — that would tell agents not to push somewhere they can.
			expect(await refreshRepoPushAccess({ db, masterKeyManager }, repoId)).toBe(true);
		} finally {
			process.env.GITHUB_API_BASE_URL = prev;
		}
		expect(await storedCanPush(repoId)).toBe(true);
	});

	it('leaves the stored value alone when the repo has no OAuth connection', async () => {
		const res = await db.query<{ id: string }>(
			`INSERT INTO repos (project_id, repo_identifier, host_type, can_push)
			 VALUES ($1, 'other-org/unlinked', 'github'::repo_host_type, NULL) RETURNING id`,
			[projectId],
		);
		expect(await refreshRepoPushAccess({ db, masterKeyManager }, res.rows[0].id)).toBeNull();
	});

	it('returns null for a repo that no longer exists', async () => {
		expect(
			await refreshRepoPushAccess({ db, masterKeyManager }, '00000000-0000-0000-0000-000000000000'),
		).toBeNull();
	});
});

describe('repo setup refreshes push access', () => {
	it('re-checks push access when setup runs, picking up a change made since linking', async () => {
		// The reclone and retry paths run setup without a fresh link-time check, so
		// setup is where a stale verdict would otherwise persist indefinitely.
		const seeded = await db.query<{ id: string }>(
			`INSERT INTO repos (project_id, repo_identifier, host_type, oauth_connection_id, setup_status, can_push)
			 VALUES ($1, 'other-org/resetup', 'github'::repo_host_type, $2, 'pending'::repo_setup_status, true)
			 RETURNING id`,
			[projectId, oauthConnectionId],
		);
		sim.state.repos.push(repo('other-org', 'resetup', { admin: false, push: false, pull: true }));

		const outcome = await performRepoSetup(
			{ db, masterKeyManager },
			{
				teamId,
				projectId,
				repoId: seeded.rows[0].id,
				repoIdentifier: 'other-org/resetup',
			},
		);

		// Settling the row is not gated on the GitHub round trip — setup still
		// reports ready, and the refreshed verdict lands alongside it.
		expect(outcome.status).toBe('ready');
		expect(await storedCanPush(seeded.rows[0].id)).toBe(false);
	});
});

describe('GET /repos/:repoId/git-state', () => {
	it('reports push access even when the container is not running', async () => {
		const seeded = await db.query<{ id: string }>(
			`INSERT INTO repos (project_id, repo_identifier, host_type, oauth_connection_id, can_push)
			 VALUES ($1, 'other-org/inspected', 'github'::repo_host_type, $2, true) RETURNING id`,
			[projectId, oauthConnectionId],
		);
		sim.state.repos.push(repo('other-org', 'inspected', { admin: false, push: false, pull: true }));
		await db.query(
			`UPDATE projects SET container_id = NULL, container_status = 'stopped' WHERE id = $1`,
			[projectId],
		);

		const res = await app.request(
			`/api/projects/${projectId}/repos/${seeded.rows[0].id}/git-state`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.container_running).toBe(false);
		// The panel is the operator's way to notice access changed on GitHub, so it
		// must answer without depending on a running container.
		expect(body.data.can_push).toBe(false);
	});
});
