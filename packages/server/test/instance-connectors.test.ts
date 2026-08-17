import { createServer } from 'node:http';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import { loadConnectorsForRun } from '../src/services/connectors/connections';
import {
	createOrFetchConnector,
	getConnector,
	statusOf,
} from '../src/services/connectors/lifecycle';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';
import { type FakeMcpServer, startFakeMcpServer } from './helpers/fake-mcp-server';

let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: MasterKeyManager;

async function makeProject(teamId: string, slug: string): Promise<string> {
	const row = await db.query<{ id: string }>(
		`INSERT INTO projects (team_id, name, slug, task_prefix, docker_base_image, container_status)
		 VALUES ($1, $2, $2, 'P', 'hezo/agent-base:latest', NULL)
		 RETURNING id`,
		[teamId, slug],
	);
	return row.rows[0].id;
}

async function makeTeam(name: string): Promise<string> {
	const res = await createTestTeam(db, { name });
	return (await res.json()).data.id;
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;
});

afterAll(async () => {
	await safeClose(db);
});

describe('global connectors', () => {
	it('a global saas connector is created, listed, and returned by the run loader', async () => {
		const createRes = await app.request('/api/connectors', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'shared-docs',
				display_name: 'Shared Docs',
				kind: 'saas',
				config: { url: 'https://mcp.example.com/docs' },
			}),
		});
		expect(createRes.status).toBe(201);
		const conn = (await createRes.json()).data;
		expect(conn.install_status).toBe('installed');
		expect(conn.kind).toBe('saas');

		// Listed under the global connectors.
		const instRes = await app.request('/api/connectors', { headers: authHeader(token) });
		expect(
			(await instRes.json()).data.some((r: { name: string }) => r.name === 'shared-docs'),
		).toBe(true);

		// The in-project connectors list (any project) shows the global catalog.
		const teamId = await makeTeam('Connectors Team');
		const projectSlug = 'connectors-project';
		await makeProject(teamId, projectSlug);

		const teamListRes = await app.request(`/api/projects/${projectSlug}/connectors`, {
			headers: authHeader(token),
		});
		const teamRows = (await teamListRes.json()).data as { name: string }[];
		expect(teamRows.some((r) => r.name === 'shared-docs')).toBe(true);

		// The run loader is the one surface that gates on reachability. The URL
		// above answers nothing here, so the create-time probe recorded that and the
		// connector stays out of runs until it is proven - it would otherwise fail
		// its handshake inside the container, where nothing here can see it.
		expect((await loadConnectorsForRun(db)).some((r) => r.name === 'shared-docs')).toBe(false);

		await db.query(`UPDATE mcp_connections SET probed_at = now(), probe_error = NULL
		                WHERE name = 'shared-docs'`);
		const forRun = await loadConnectorsForRun(db);
		expect(forRun.some((r) => r.name === 'shared-docs')).toBe(true);
	});

	it('paginates the global connectors list with offset + total meta', async () => {
		for (const name of ['page-a', 'page-b', 'page-c']) {
			const res = await app.request('/api/connectors', {
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name,
					kind: 'saas',
					config: { url: `https://${name}.example.com/mcp` },
				}),
			});
			expect(res.status).toBe(201);
		}

		const all = await app.request('/api/connectors?per_page=200', { headers: authHeader(token) });
		const total = (await all.json()).meta.total as number;
		expect(total).toBeGreaterThanOrEqual(3);

		const p1 = await app.request('/api/connectors?page=1&per_page=2', {
			headers: authHeader(token),
		});
		const b1 = await p1.json();
		expect(b1.meta).toEqual({ page: 1, per_page: 2, total });
		expect(b1.data).toHaveLength(2);

		const p2 = await app.request('/api/connectors?page=2&per_page=2', {
			headers: authHeader(token),
		});
		const b2 = await p2.json();
		expect(b2.meta.page).toBe(2);
		const ids1 = b1.data.map((r: { id: string }) => r.id);
		const ids2 = b2.data.map((r: { id: string }) => r.id);
		expect(ids1.some((id: string) => ids2.includes(id))).toBe(false);
	});

	it('rejects a local connector at the instance level', async () => {
		const res = await app.request('/api/connectors', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'local-thing',
				kind: 'local',
				config: { command: 'npx' },
			}),
		});
		expect(res.status).toBe(400);
	});

	it('rejects a saas connector without config.url', async () => {
		const res = await app.request('/api/connectors', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'no-url', kind: 'saas', config: {} }),
		});
		expect(res.status).toBe(400);
	});

	it('deletes an instance connector', async () => {
		const createRes = await app.request('/api/connectors', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'to-delete',
				kind: 'saas',
				config: { url: 'https://delete.example.com/mcp' },
			}),
		});
		const id = (await createRes.json()).data.id;

		const del = await app.request(`/api/connectors/${id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(del.status).toBe(200);

		const instRes = await app.request('/api/connectors', { headers: authHeader(token) });
		expect((await instRes.json()).data.some((r: { id: string }) => r.id === id)).toBe(false);

		// Deleting again is a 404.
		const again = await app.request(`/api/connectors/${id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(again.status).toBe(404);
	});

	it('requires superuser for instance connector management', async () => {
		const nonSuper = await db.query<{ id: string }>(
			"INSERT INTO users (display_name, is_superuser) VALUES ('Member', false) RETURNING id",
		);
		const memberToken = await signAdminJwt(masterKeyManager, nonSuper.rows[0].id);

		const listRes = await app.request('/api/connectors', {
			headers: authHeader(memberToken),
		});
		expect(listRes.status).toBe(403);

		const postRes = await app.request('/api/connectors', {
			method: 'POST',
			headers: { ...authHeader(memberToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'nope',
				kind: 'saas',
				config: { url: 'https://x.example.com/mcp' },
			}),
		});
		expect(postRes.status).toBe(403);
	});
});

describe('instance connector OAuth (admin auth-start)', () => {
	let fake: FakeMcpServer;

	beforeAll(async () => {
		fake = await startFakeMcpServer();
	});

	afterAll(async () => {
		await fake.close();
	});

	async function createSaasConnector(name: string, url: string): Promise<{ id: string }> {
		const res = await app.request('/api/connectors', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name, kind: 'saas', config: { url } }),
		});
		expect(res.status).toBe(201);
		return (await res.json()).data as { id: string };
	}

	async function driveCallback(authUrl: string): Promise<Response> {
		// The fake AS auto-approves and 302s to our redirect_uri with code+state;
		// capture those and drive the callback handler directly.
		const authorizeRes = await fetch(authUrl, { redirect: 'manual' });
		expect(authorizeRes.status).toBe(302);
		const loc = new URL(authorizeRes.headers.get('location')!);
		const code = loc.searchParams.get('code')!;
		const state = loc.searchParams.get('state')!;
		return app.request(
			`/api/oauth/mcp-callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
		);
	}

	it('performs DCR and completes the callback with no team context', async () => {
		const conn = await createSaasConnector('higgsfield', `${fake.url}/mcp`);

		const startRes = await app.request(`/api/connectors/${conn.id}/auth-start`, {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(startRes.status).toBe(200);
		const { data } = (await startRes.json()) as { data: { auth_url: string | null } };
		expect(data.auth_url).toContain(`${fake.url}/authorize`);
		expect(data.auth_url).toContain('client_id=fake_');
		expect(data.auth_url).toContain('code_challenge=');

		// DCR registration persisted on the row…
		const withDcr = await getConnector(db, conn.id);
		const config = withDcr!.config as { dcr?: { client_id: string } };
		expect(config.dcr?.client_id).toBe(fake.lastClientId());

		// …which marks the row known-OAuth: excluded from runs until authorized.
		expect((await loadConnectorsForRun(db)).find((r) => r.name === 'higgsfield')).toBe(undefined);

		const cbRes = await driveCallback(data.auth_url!);
		expect(cbRes.status).toBe(200);
		expect(await cbRes.text()).toContain('OAuth connection complete');

		const after = await getConnector(db, conn.id);
		expect(after?.oauth_connection_id).toBeTruthy();
		expect(after?.activated_at).toBeTruthy();
		expect(statusOf(after!)).toBe('active');

		// Token secret landed in the vault.
		const secretRow = await db.query<{ name: string }>(
			`SELECT s.name FROM oauth_connections oc
			 JOIN secrets s ON s.id = oc.access_token_secret_id
			 WHERE oc.id = $1`,
			[after!.oauth_connection_id],
		);
		expect(secretRow.rows[0].name).toMatch(/^OAUTH_MCP_/);

		// The DCR client id has to land on the connection metadata, not just in
		// mcp_connections.config.dcr — the generic host-side refresh reads it from
		// there and cannot refresh the token without it.
		const meta = await db.query<{ metadata: Record<string, unknown> }>(
			`SELECT metadata FROM oauth_connections WHERE id = $1`,
			[after!.oauth_connection_id],
		);
		expect(meta.rows[0].metadata.client_id).toBe(fake.lastClientId());
		expect(meta.rows[0].metadata.token_url).toBeTruthy();

		// Authorized → injected into runs again.
		const forRun = await loadConnectorsForRun(db);
		expect(forRun.find((r) => r.name === 'higgsfield')?.oauth_connection_id).toBeTruthy();
	});

	it('resolves to auth_url null when the server advertises no PRM, without failing the connector', async () => {
		// A plain HTTP server with no OAuth surface at all: everything 404s —
		// the shape of a public or header-authenticated MCP.
		const plain = createServer((_req, res) => {
			res.statusCode = 404;
			res.end('not found');
		});
		await new Promise<void>((resolve) => plain.listen(0, '127.0.0.1', resolve));
		const port = (plain.address() as { port: number }).port;
		try {
			const conn = await createSaasConnector('header-auth-mcp', `http://127.0.0.1:${port}/mcp`);
			const res = await app.request(`/api/connectors/${conn.id}/auth-start`, {
				method: 'POST',
				headers: authHeader(token),
			});
			expect(res.status).toBe(200);
			const { data } = (await res.json()) as {
				data: { auth_url: string | null; reason?: string };
			};
			expect(data.auth_url).toBeNull();
			expect(data.reason).toMatch(/Could not discover OAuth endpoints/);

			// A failed OAuth discovery is not a failed connector: `auth_error` stays
			// clear and the row reads pending, so the operator sees "not connected
			// yet" rather than "this broke".
			const row = await getConnector(db, conn.id);
			expect(row?.auth_error).toBeNull();
			expect(statusOf(row!)).toBe('pending');
			// It does not reach a run, though. This server answers nothing, so there
			// is no evidence it can be talked to, and handing it to a run would only
			// fail the handshake inside the container where nothing here sees it.
			expect(
				(await loadConnectorsForRun(db)).find((r) => r.name === 'header-auth-mcp'),
			).toBeUndefined();
		} finally {
			await new Promise<void>((resolve, reject) => plain.close((e) => (e ? reject(e) : resolve())));
		}
	});

	it('marks the connector failed and keeps it out of runs when OAuth is advertised but DCR unsupported', async () => {
		const noDcr = await startFakeMcpServer({ noRegistrationEndpoint: true });
		try {
			const conn = await createSaasConnector('no-dcr', `${noDcr.url}/mcp`);
			const res = await app.request(`/api/connectors/${conn.id}/auth-start`, {
				method: 'POST',
				headers: authHeader(token),
			});
			expect(res.status).toBe(400);
			expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
				'OAUTH_DCR_UNSUPPORTED',
			);

			const row = await getConnector(db, conn.id);
			expect(statusOf(row!)).toBe('failed');
			expect(row?.auth_error).toContain('registration_endpoint');
			expect((await loadConnectorsForRun(db)).find((r) => r.name === 'no-dcr')).toBe(undefined);
		} finally {
			await noDcr.close();
		}
	});

	it('re-adding the same name clears a previous OAuth failure', async () => {
		const noDcr = await startFakeMcpServer({ noRegistrationEndpoint: true });
		try {
			const conn = await createSaasConnector('readd-me', `${noDcr.url}/mcp`);
			await app.request(`/api/connectors/${conn.id}/auth-start`, {
				method: 'POST',
				headers: authHeader(token),
			});
			expect((await getConnector(db, conn.id))?.auth_error).toBeTruthy();

			const readd = await createSaasConnector('readd-me', 'https://corrected.example.com/mcp');
			expect(readd.id).toBe(conn.id);
			const row = await getConnector(db, conn.id);
			expect(row?.auth_error).toBeNull();
			expect(statusOf(row!)).toBe('pending');
		} finally {
			await noDcr.close();
		}
	});

	it('rejects auth-start for non-superusers, unknown, and local connectors', async () => {
		const conn = await createSaasConnector('authz-check', `${fake.url}/mcp`);

		const nonSuper = await db.query<{ id: string }>(
			"INSERT INTO users (display_name, is_superuser) VALUES ('Member2', false) RETURNING id",
		);
		const memberToken = await signAdminJwt(masterKeyManager, nonSuper.rows[0].id);
		const forbidden = await app.request(`/api/connectors/${conn.id}/auth-start`, {
			method: 'POST',
			headers: authHeader(memberToken),
		});
		expect(forbidden.status).toBe(403);

		const missing = await app.request(
			'/api/connectors/00000000-0000-0000-0000-000000000000/auth-start',
			{ method: 'POST', headers: authHeader(token) },
		);
		expect(missing.status).toBe(404);

		// Local kind (inserted directly — the admin POST rejects local creation).
		const local = await db.query<{ id: string }>(
			`INSERT INTO mcp_connections (name, kind, config, install_status)
			 VALUES ('local-authz', 'local'::mcp_connection_kind, '{"command": "npx"}'::jsonb, 'installed'::mcp_install_status)
			 RETURNING id`,
		);
		const localRes = await app.request(`/api/connectors/${local.rows[0].id}/auth-start`, {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(localRes.status).toBe(400);
	});

	it('restores a revoked connector in place on auth-start (admin surface)', async () => {
		const revoked = await createSaasConnector('revoked-authz', `${fake.url}/mcp`);
		await db.query(`UPDATE mcp_connections SET revoked_at = now() WHERE id = $1`, [revoked.id]);
		const revokedRes = await app.request(`/api/connectors/${revoked.id}/auth-start`, {
			method: 'POST',
			headers: authHeader(token),
		});
		// Restored + re-authorized rather than rejected: the DCR walk returns an
		// authorize URL and the row is left un-revoked.
		expect(revokedRes.status).toBe(200);
		const authUrl = ((await revokedRes.json()) as { data: { auth_url: string } }).data.auth_url;
		expect(authUrl).toContain(`${fake.url}/authorize`);
		const after = await getConnector(db, revoked.id);
		expect(after?.revoked_at).toBeNull();
	});

	it("fires the credential_provided wakeup under the requesting task's team when connected from the admin surface", async () => {
		const teamRes = await createTestTeam(db, { name: 'Wakeup Team' });
		const wTeamId = (await teamRes.json()).data.id;
		const projectRes = await createTestProject(db, wTeamId, { name: 'Wakeup Project' });
		const wProjectId = (await projectRes.json()).data.id;
		const agent = await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 LIMIT 1`,
			[wTeamId],
		);
		const agentId = agent.rows[0].id;
		const taskRes = await db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier, title)
			 SELECT $1, $2, $3, COALESCE(MAX(number), 0) + 1, 'WKP-' || (COALESCE(MAX(number), 0) + 1)::text, 'needs connector'
			 FROM tasks WHERE project_id = $2
			 RETURNING id`,
			[wTeamId, wProjectId, agentId],
		);
		const taskId = taskRes.rows[0].id;

		const { row } = await createOrFetchConnector(db, {
			name: 'agent-requested',
			displayName: 'Agent Requested',
			mcpUrl: `${fake.url}/mcp`,
			mcpTransport: 'http',
			createdByTaskId: taskId,
		});

		const startRes = await app.request(`/api/connectors/${row.id}/auth-start`, {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(startRes.status).toBe(200);
		const { data } = (await startRes.json()) as { data: { auth_url: string | null } };
		const cbRes = await driveCallback(data.auth_url!);
		expect(cbRes.status).toBe(200);
		expect(await cbRes.text()).toContain('OAuth connection complete');

		// The wakeup insert is fire-and-forget (trackBackground); drain it before
		// asserting.
		const { waitForBackground } = await import('../src/lib/background');
		await waitForBackground();

		// The wakeup scope comes from the task's own team, even though the
		// connect was completed with no team context at all.
		const wakeup = await db.query<{ team_id: string }>(
			`SELECT team_id FROM agent_wakeup_requests
			 WHERE member_id = $1 AND source = 'credential_provided'::wakeup_source`,
			[agentId],
		);
		expect(wakeup.rows.length).toBeGreaterThan(0);
		expect(wakeup.rows[0].team_id).toBe(wTeamId);
	});
});
