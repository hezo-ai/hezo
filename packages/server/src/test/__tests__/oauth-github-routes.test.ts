import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../lib/types';
import { safeClose } from '../helpers';
import { authHeader, createTestApp } from '../helpers/app';
import { createGitHubSim, type GitHubSim } from '../helpers/github-sim';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let companyId: string;
let sim: GitHubSim;

let prevApi: string | undefined;
let prevOauth: string | undefined;
let prevClient: string | undefined;

beforeAll(async () => {
	sim = await createGitHubSim();
	prevApi = process.env.GITHUB_API_BASE_URL;
	prevOauth = process.env.GITHUB_OAUTH_BASE_URL;
	prevClient = process.env.GITHUB_OAUTH_CLIENT_ID;
	process.env.GITHUB_API_BASE_URL = sim.baseUrl;
	process.env.GITHUB_OAUTH_BASE_URL = sim.baseUrl;
	process.env.GITHUB_OAUTH_CLIENT_ID = 'test-client-id';

	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const typesRes = await app.request('/api/company-types', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: { name: string }) => t.name === 'Startup',
	).id;
	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'GitHub Co', template_id: typeId }),
	});
	companyId = (await companyRes.json()).data.id;
});

afterAll(async () => {
	process.env.GITHUB_API_BASE_URL = prevApi;
	process.env.GITHUB_OAUTH_BASE_URL = prevOauth;
	process.env.GITHUB_OAUTH_CLIENT_ID = prevClient;
	await sim.destroy();
	await safeClose(db);
});

describe('GitHub device-flow routes', () => {
	it('drives the full device flow end-to-end: start → pending → approve → success persists a connection and registers signing key', async () => {
		sim.seed({
			token: 'gho_e2e_token',
			user: { id: 7, login: 'octo-e2e', avatar_url: 'http://av/octo.png', email: 'octo@e2e' },
			signingKeys: [],
		});

		const startRes = await app.request(`/api/companies/${companyId}/oauth/github/device-start`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(startRes.status).toBe(200);
		const startBody = (await startRes.json()) as { data: { flow_id: string; user_code: string } };
		const { flow_id: flowId, user_code: userCode } = startBody.data;

		const pendingRes = await app.request(`/api/companies/${companyId}/oauth/github/device-poll`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ flow_id: flowId }),
		});
		expect(pendingRes.status).toBe(202);
		expect(((await pendingRes.json()) as { data: { status: string } }).data.status).toBe('pending');

		sim.approveDeviceFlow(userCode);

		const successRes = await app.request(`/api/companies/${companyId}/oauth/github/device-poll`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ flow_id: flowId }),
		});
		expect(successRes.status).toBe(200);
		const successBody = (await successRes.json()) as {
			data: {
				status: string;
				connection: {
					provider: string;
					provider_account_id: string;
					provider_account_label: string;
					metadata: Record<string, unknown>;
				};
			};
		};
		expect(successBody.data.status).toBe('success');
		expect(successBody.data.connection.provider).toBe('github');
		expect(successBody.data.connection.provider_account_id).toBe('7');
		expect(successBody.data.connection.provider_account_label).toBe('octo-e2e');
		expect(successBody.data.connection.metadata).toMatchObject({ login: 'octo-e2e' });

		expect(sim.state.signingKeys.length).toBe(1);
		expect(sim.state.signingKeys[0].title).toBe('Hezo signing key');

		const conn = await db.query<{ id: string }>(
			`SELECT id FROM oauth_connections WHERE company_id = $1`,
			[companyId],
		);
		expect(conn.rows.length).toBe(1);

		const secret = await db.query<{ name: string; allowed_hosts: string[] }>(
			`SELECT name, allowed_hosts FROM secrets WHERE company_id = $1 AND name LIKE 'OAUTH_GITHUB_%'`,
			[companyId],
		);
		expect(secret.rows.length).toBe(1);
		expect(secret.rows[0].allowed_hosts).toEqual(['github.com', 'api.github.com']);
	});

	it('rejects a poll with an unknown flow_id', async () => {
		const res = await app.request(`/api/companies/${companyId}/oauth/github/device-poll`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ flow_id: 'bad' }),
		});
		expect(res.status).toBe(404);
	});

	it('lists connections — does not leak token values', async () => {
		const res = await app.request(`/api/companies/${companyId}/oauth-connections`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { data: Array<Record<string, unknown>> };
		expect(body.data.length).toBe(1);
		expect(JSON.stringify(body.data[0])).not.toContain('gho_e2e_token');
		expect(body.data[0]).toMatchObject({
			provider: 'github',
			provider_account_label: 'octo-e2e',
		});
		expect(body.data[0]).not.toHaveProperty('access_token');
	});

	it('deletes a connection — also removes its secret rows and 404s on the next list/get', async () => {
		const list = await app.request(`/api/companies/${companyId}/oauth-connections`, {
			headers: authHeader(token),
		});
		const conn = ((await list.json()) as { data: Array<{ id: string }> }).data[0];

		const del = await app.request(`/api/companies/${companyId}/oauth-connections/${conn.id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(del.status).toBe(200);

		const after = await db.query(`SELECT id FROM oauth_connections WHERE id = $1`, [conn.id]);
		expect(after.rows.length).toBe(0);

		const secrets = await db.query(
			`SELECT id FROM secrets WHERE company_id = $1 AND name LIKE 'OAUTH_GITHUB_%'`,
			[companyId],
		);
		expect(secrets.rows.length).toBe(0);

		const delAgain = await app.request(`/api/companies/${companyId}/oauth-connections/${conn.id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(delAgain.status).toBe(404);
	});

	it("cross-company isolation: cannot delete another company's connection", async () => {
		const otherCompanyRes = await app.request('/api/companies', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Outsider',
				template_id: (
					await (await app.request('/api/company-types', { headers: authHeader(token) })).json()
				).data[0].id,
			}),
		});
		const otherCompanyId = (await otherCompanyRes.json()).data.id;

		const directInsert = await db.query<{ id: string }>(
			`INSERT INTO secrets (company_id, name, encrypted_value, category, allowed_hosts)
			 VALUES ($1, 'OAUTH_GITHUB_DUMMY1', 'placeholder', 'api_token', ARRAY['github.com'])
			 RETURNING id`,
			[otherCompanyId],
		);
		const secretId = directInsert.rows[0].id;
		const conn = await db.query<{ id: string }>(
			`INSERT INTO oauth_connections (company_id, provider, provider_account_id, provider_account_label, access_token_secret_id, scopes)
			 VALUES ($1, 'github', '999', 'outsider', $2, ARRAY['repo'])
			 RETURNING id`,
			[otherCompanyId, secretId],
		);
		const otherConnectionId = conn.rows[0].id;

		const res = await app.request(
			`/api/companies/${companyId}/oauth-connections/${otherConnectionId}`,
			{
				method: 'DELETE',
				headers: authHeader(token),
			},
		);
		expect(res.status).toBe(404);
	});
});
