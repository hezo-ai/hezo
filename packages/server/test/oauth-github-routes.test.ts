import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestTeam, projectSlugFor } from './helpers/app';
import { createGitHubSim, type GitHubSim } from './helpers/github-sim';

let app: Hono<Env>;
let db: Db;
let token: string;
let teamId: string;
let projectSlug: string;
let sim: GitHubSim;

let prevApi: string | undefined;
let prevOAuth: string | undefined;
const issuedToken = 'gho_device_test_token';

beforeAll(async () => {
	sim = await createGitHubSim();
	prevApi = process.env.GITHUB_API_BASE_URL;
	prevOAuth = process.env.GITHUB_OAUTH_BASE_URL;
	// The sim serves both the REST API (/user, /user/keys) and the OAuth device
	// endpoints (/login/device/code, /login/oauth/access_token) on one origin.
	process.env.GITHUB_API_BASE_URL = sim.baseUrl;
	process.env.GITHUB_OAUTH_BASE_URL = sim.baseUrl;

	sim.seed({
		token: issuedToken,
		user: { id: 7, login: 'octo-e2e', avatar_url: 'http://av/octo.png', email: 'octo@e2e' },
		signingKeys: [],
		authKeys: [],
	});

	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: { name: string }) => t.name === 'App Team',
	).id;
	const teamRes = await createTestTeam(db, { name: 'GitHub Co', template_id: typeId });
	const team = (await teamRes.json()).data as { id: string; slug: string };
	teamId = team.id;
	projectSlug = `${await projectSlugFor(db, team.id)}`;
});

afterAll(async () => {
	process.env.GITHUB_API_BASE_URL = prevApi;
	process.env.GITHUB_OAUTH_BASE_URL = prevOAuth;
	await sim.destroy();
	await safeClose(db);
});

describe('GitHub device-flow connector', () => {
	it('drives the full device flow: ensure → device/start → poll(pending) → approve → poll(success) → oauth row + SSH keys + active connector', async () => {
		// Materialize the connector the real way, from the registry capability.
		const ensureRes = await app.request(`/api/projects/${projectSlug}/connectors/ensure`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ provider_id: 'github' }),
		});
		expect(ensureRes.status).toBe(200);
		const connectorId = ((await ensureRes.json()) as { data: { id: string } }).data.id;

		// GitHub can't do DCR, so auth-start must refuse and point at the device flow.
		const authStartRes = await app.request(`/api/projects/${projectSlug}/auth-start`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ connector_id: connectorId }),
		});
		expect(authStartRes.status).toBe(400);
		expect(((await authStartRes.json()) as { error: { code: string } }).error.code).toBe(
			'USE_DEVICE_FLOW',
		);

		// device/start hands back a user code + the registry scope list.
		const startRes = await app.request(
			`/api/projects/${projectSlug}/connectors/${connectorId}/device/start`,
			{ method: 'POST', headers: { ...authHeader(token), 'Content-Type': 'application/json' } },
		);
		expect(startRes.status).toBe(200);
		const { data: start } = (await startRes.json()) as {
			data: { flow_id: string; user_code: string; verification_uri: string };
		};
		expect(start.user_code).toBeTruthy();
		expect(start.flow_id).toBeTruthy();

		// Before the user authorizes, polling is pending (202).
		const pendingRes = await app.request(
			`/api/projects/${projectSlug}/connectors/${connectorId}/device/poll`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ flow_id: start.flow_id }),
			},
		);
		expect(pendingRes.status).toBe(202);
		expect(((await pendingRes.json()) as { data: { status: string } }).data.status).toBe('pending');

		// User authorizes at github.com/login/device → sim mints the token.
		sim.approveDeviceFlow(start.user_code, issuedToken);

		const successRes = await app.request(
			`/api/projects/${projectSlug}/connectors/${connectorId}/device/poll`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ flow_id: start.flow_id }),
			},
		);
		expect(successRes.status).toBe(200);
		const { data: success } = (await successRes.json()) as {
			data: { status: string; connection: { provider_account_label: string } };
		};
		expect(success.status).toBe('success');
		expect(success.connection.provider_account_label).toBe('octo-e2e');

		// oauth_connections row landed with provider='github' and the real identity
		// from github-sim, not a synthetic mcp:* account id.
		const conn = await db.query<{
			provider: string;
			provider_account_id: string;
			provider_account_label: string;
			scopes: string[];
		}>(
			`SELECT provider, provider_account_id, provider_account_label, scopes
			 FROM oauth_connections`,
		);
		expect(conn.rows.length).toBe(1);
		expect(conn.rows[0]).toMatchObject({
			provider: 'github',
			provider_account_id: '7',
			provider_account_label: 'octo-e2e',
		});
		expect(conn.rows[0].scopes).toEqual([
			'repo',
			'workflow',
			'read:org',
			'write:ssh_signing_key',
			'write:public_key',
		]);

		// The capability registry's allowed_hosts lands on the secret (egress proxy)
		// — the GitHub MCP host so the injector can authorize MCP calls, and both
		// git hosts: `github.com` serves the ref advertisement and
		// `codeload.github.com` the packfiles, so a clone needs the pair.
		const secret = await db.query<{ allowed_hosts: string[] }>(
			`SELECT s.allowed_hosts FROM oauth_connections oc
			 JOIN secrets s ON s.id = oc.access_token_secret_id`,
		);
		expect(secret.rows[0].allowed_hosts).toEqual([
			'api.githubcopilot.com',
			'api.github.com',
			'github.com',
			'codeload.github.com',
		]);

		// SSH keys registered on the user's GitHub account.
		expect(sim.state.signingKeys.length).toBe(1);
		expect(sim.state.signingKeys[0].title).toBe('Hezo signing key');
		expect(sim.state.authKeys.length).toBe(1);
		expect(sim.state.authKeys[0].title).toBe('Hezo authentication key');
		expect(sim.state.authKeys[0].key).toBe(sim.state.signingKeys[0].key);

		// Connector marked active.
		const conRow = await db.query<{
			oauth_connection_id: string | null;
			activated_at: string | null;
		}>(`SELECT oauth_connection_id, activated_at FROM mcp_connections WHERE id = $1`, [
			connectorId,
		]);
		expect(conRow.rows[0].oauth_connection_id).toBeTruthy();
		expect(conRow.rows[0].activated_at).toBeTruthy();
	});

	it('rejects a poll for a flow that belongs to another connector', async () => {
		const otherConnector = await db.query<{ id: string }>(
			`INSERT INTO mcp_connections (name, display_name, kind, config, install_status)
			 VALUES ('github', 'GitHub', 'saas'::mcp_connection_kind, '{}'::jsonb, 'installed')
			 ON CONFLICT (name) WHERE project_id IS NULL DO UPDATE SET display_name = EXCLUDED.display_name
			 RETURNING id`,
		);
		const start = await app.request(
			`/api/projects/${projectSlug}/connectors/${otherConnector.rows[0].id}/device/start`,
			{ method: 'POST', headers: { ...authHeader(token), 'Content-Type': 'application/json' } },
		);
		const { data } = (await start.json()) as { data: { flow_id: string } };

		// Poll the same flow_id against a different connector path → forbidden.
		const mismatched = await app.request(
			`/api/projects/${projectSlug}/connectors/${crypto.randomUUID()}/device/poll`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ flow_id: data.flow_id }),
			},
		);
		expect([403, 404]).toContain(mismatched.status);
	});

	it('lists connections — does not leak token values', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/oauth-connections`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { data: Array<Record<string, unknown>> };
		expect(body.data.length).toBe(1);
		expect(JSON.stringify(body.data[0])).not.toContain(issuedToken);
		expect(body.data[0]).toMatchObject({
			provider: 'github',
			provider_account_label: 'octo-e2e',
		});
		expect(body.data[0]).not.toHaveProperty('access_token');
	});

	it('deletes a connection — also removes its secret rows and 404s on the next list/get', async () => {
		const list = await app.request(`/api/projects/${projectSlug}/oauth-connections`, {
			headers: authHeader(token),
		});
		const conn = ((await list.json()) as { data: Array<{ id: string }> }).data[0];

		const del = await app.request(`/api/projects/${projectSlug}/oauth-connections/${conn.id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(del.status).toBe(200);

		const after = await db.query(`SELECT id FROM oauth_connections WHERE id = $1`, [conn.id]);
		expect(after.rows.length).toBe(0);

		const secrets = await db.query(`SELECT id FROM secrets WHERE name LIKE 'OAUTH_GITHUB_%'`);
		expect(secrets.rows.length).toBe(0);

		const delAgain = await app.request(
			`/api/projects/${projectSlug}/oauth-connections/${conn.id}`,
			{
				method: 'DELETE',
				headers: authHeader(token),
			},
		);
		expect(delAgain.status).toBe(404);
	});
});
