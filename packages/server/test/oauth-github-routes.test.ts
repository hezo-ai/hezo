import type { PGlite } from '@electric-sql/pglite';
import { McpConnectionKind } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';
import { type FakeMcpServer, startFakeMcpServer } from './helpers/fake-mcp-server';
import { createGitHubSim, type GitHubSim } from './helpers/github-sim';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let teamId: string;
let sim: GitHubSim;
let fakeAS: FakeMcpServer;

let prevApi: string | undefined;
const issuedToken = 'gho_unified_test_token';

beforeAll(async () => {
	sim = await createGitHubSim();
	prevApi = process.env.GITHUB_API_BASE_URL;
	process.env.GITHUB_API_BASE_URL = sim.baseUrl;

	sim.seed({
		token: issuedToken,
		user: { id: 7, login: 'octo-e2e', avatar_url: 'http://av/octo.png', email: 'octo@e2e' },
		signingKeys: [],
		authKeys: [],
	});

	fakeAS = await startFakeMcpServer({ issueToken: issuedToken });

	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: { name: string }) => t.name === 'Startup',
	).id;
	const teamRes = await app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'GitHub Co', template_id: typeId }),
	});
	teamId = (await teamRes.json()).data.id;
});

afterAll(async () => {
	process.env.GITHUB_API_BASE_URL = prevApi;
	await sim.destroy();
	await fakeAS.close();
	await safeClose(db);
});

describe('GitHub unified connector (auth-code via MCP server)', () => {
	it('drives the full auth-code flow: ensure → auth-start (registry scopes) → callback (oauth row + SSH key)', async () => {
		// Override the GitHub MCP URL to point at our fake AS for this test —
		// the production registry points at https://api.githubcopilot.com/mcp/
		// which we can't reach from CI.
		await db.query(
			`INSERT INTO mcp_connections (team_id, name, display_name, kind, config, install_status)
			 VALUES ($1, 'github', 'GitHub', $2::mcp_connection_kind, $3::jsonb, 'installed')`,
			[teamId, McpConnectionKind.Saas, JSON.stringify({ url: `${fakeAS.url}/mcp` })],
		);
		const connRow = await db.query<{ id: string }>(
			`SELECT id FROM mcp_connections WHERE team_id = $1 AND name = 'github'`,
			[teamId],
		);
		const connectorId = connRow.rows[0].id;

		// auth-start must produce an authorize URL with the capability registry's
		// scope list — not the AS's broad `scopes_supported`.
		const startRes = await app.request(`/api/teams/${teamId}/auth-start`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ connector_id: connectorId }),
		});
		expect(startRes.status).toBe(200);
		const { data: startData } = (await startRes.json()) as { data: { auth_url: string } };

		const startUrl = new URL(startData.auth_url);
		const requestedScopes = (startUrl.searchParams.get('scope') ?? '').split(' ');
		expect(requestedScopes).toEqual([
			'repo',
			'workflow',
			'read:org',
			'write:ssh_signing_key',
			'write:public_key',
		]);

		// Follow the authorize URL — fake AS auto-approves and 302s with code+state.
		const authorizeRes = await fetch(startData.auth_url, { redirect: 'manual' });
		expect(authorizeRes.status).toBe(302);
		const location = authorizeRes.headers.get('location')!;
		const locUrl = new URL(location);
		const code = locUrl.searchParams.get('code')!;
		const state = locUrl.searchParams.get('state')!;

		const cbRes = await app.request(
			`/api/oauth/mcp-callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
		);
		expect(cbRes.status).toBe(200);
		const html = await cbRes.text();
		expect(html).toContain('OAuth connection complete');

		// oauth_connections row landed with provider='github' and the user identity
		// from github-sim, not a synthetic mcp:* account id.
		const conn = await db.query<{
			provider: string;
			provider_account_id: string;
			provider_account_label: string;
		}>(
			`SELECT provider, provider_account_id, provider_account_label
			 FROM oauth_connections WHERE team_id = $1`,
			[teamId],
		);
		expect(conn.rows.length).toBe(1);
		expect(conn.rows[0]).toMatchObject({
			provider: 'github',
			provider_account_id: '7',
			provider_account_label: 'octo-e2e',
		});

		// The capability registry's allowed_hosts lands on the secret (egress proxy).
		const secret = await db.query<{ allowed_hosts: string[] }>(
			`SELECT s.allowed_hosts FROM oauth_connections oc
			 JOIN secrets s ON s.id = oc.access_token_secret_id
			 WHERE oc.team_id = $1`,
			[teamId],
		);
		expect(secret.rows[0].allowed_hosts).toEqual([
			'api.githubcopilot.com',
			'api.github.com',
			'github.com',
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

	it('lists connections — does not leak token values', async () => {
		const res = await app.request(`/api/teams/${teamId}/oauth-connections`, {
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
		const list = await app.request(`/api/teams/${teamId}/oauth-connections`, {
			headers: authHeader(token),
		});
		const conn = ((await list.json()) as { data: Array<{ id: string }> }).data[0];

		const del = await app.request(`/api/teams/${teamId}/oauth-connections/${conn.id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(del.status).toBe(200);

		const after = await db.query(`SELECT id FROM oauth_connections WHERE id = $1`, [conn.id]);
		expect(after.rows.length).toBe(0);

		const secrets = await db.query(
			`SELECT id FROM secrets WHERE team_id = $1 AND name LIKE 'OAUTH_GITHUB_%'`,
			[teamId],
		);
		expect(secrets.rows.length).toBe(0);

		const delAgain = await app.request(`/api/teams/${teamId}/oauth-connections/${conn.id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(delAgain.status).toBe(404);
	});

	it("cross-team isolation: cannot delete another team's connection", async () => {
		const otherTeamRes = await app.request('/api/teams', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Outsider',
				template_id: (
					await (await app.request('/api/team-templates', { headers: authHeader(token) })).json()
				).data[0].id,
			}),
		});
		const otherTeamId = (await otherTeamRes.json()).data.id;

		const directInsert = await db.query<{ id: string }>(
			`INSERT INTO secrets (team_id, name, encrypted_value, category, allowed_hosts)
			 VALUES ($1, 'OAUTH_GITHUB_DUMMY1', 'placeholder', 'api_token', ARRAY['github.com'])
			 RETURNING id`,
			[otherTeamId],
		);
		const secretId = directInsert.rows[0].id;
		const conn = await db.query<{ id: string }>(
			`INSERT INTO oauth_connections (team_id, provider, provider_account_id, provider_account_label, access_token_secret_id, scopes)
			 VALUES ($1, 'github', '999', 'outsider', $2, ARRAY['repo'])
			 RETURNING id`,
			[otherTeamId, secretId],
		);
		const otherConnectionId = conn.rows[0].id;

		const res = await app.request(`/api/teams/${teamId}/oauth-connections/${otherConnectionId}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(404);
	});
});
