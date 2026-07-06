import { createServer, type Server } from 'node:http';
import type { Hono } from 'hono';
import { Hono as HonoApp } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { createOrFetchConnector, getConnector } from '../src/services/connectors/lifecycle';
import { signState } from '../src/services/oauth/state';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestTeam, projectSlugFor } from './helpers/app';
import { createGitHubSim, type GitHubSim } from './helpers/github-sim';

/**
 * Line/branch coverage for the device-flow half of `routes/oauth.ts`:
 * device/start failure mapping, poll branches (pending / failed / flow expiry /
 * connector churn mid-flow), the finalize helper's provider hooks (GitHub
 * identity + SSH-key registration, non-fatal afterConnect failure), the
 * CredentialProvided wakeup, and the mcp-callback finalize-failure branch.
 * GitHub is simulated by the local github-sim; no real network.
 */

interface LocalSim {
	baseUrl: string;
	destroy(): Promise<void>;
}

async function serveHono(app: HonoApp): Promise<LocalSim> {
	const server: Server = createServer(async (req, res) => {
		const headers = new Headers();
		for (const [k, v] of Object.entries(req.headers)) {
			if (v) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
		}
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
		const response = await app.fetch(
			new Request(`http://localhost${req.url}`, {
				method: req.method,
				headers,
				body: body && req.method !== 'GET' && req.method !== 'HEAD' ? body : undefined,
			}),
		);
		res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
		res.end(Buffer.from(await response.arrayBuffer()));
	});
	await new Promise<void>((resolve) => server.listen(0, resolve));
	const addr = server.address();
	const port = typeof addr === 'object' && addr ? addr.port : 0;
	return {
		baseUrl: `http://localhost:${port}`,
		destroy: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

/** GitHub-shaped origin whose device endpoints work but SSH-key routes 500. */
async function startBrokenKeysGitHubSim(): Promise<LocalSim> {
	const app = new HonoApp();
	app.post('/login/device/code', (c) =>
		c.json({
			device_code: 'bk-device',
			user_code: 'BK-CODE',
			verification_uri: 'http://localhost/login/device',
			expires_in: 900,
			interval: 5,
		}),
	);
	// Auto-approves: the first poll already returns a token.
	app.post('/login/oauth/access_token', (c) =>
		c.json({ access_token: 'bk_token', token_type: 'bearer', scope: 'repo' }),
	);
	app.get('/user', (c) =>
		c.json({ id: 4242, login: 'broken-keys-user', avatar_url: '', email: null }),
	);
	app.post('/user/ssh_signing_keys', (c) => c.json({ message: 'boom' }, 500));
	app.post('/user/keys', (c) => c.json({ message: 'boom' }, 500));
	return serveHono(app);
}

/** Origin whose device-code endpoint always 500s — start must map to 503. */
async function startBrokenStartSim(): Promise<LocalSim> {
	const app = new HonoApp();
	app.post('/login/device/code', (c) => c.json({ message: 'nope' }, 500));
	return serveHono(app);
}

let app: Hono<Env>;
let db: Db;
let token: string;
let teamId: string;
let projectSlug: string;
let masterKeyManager: MasterKeyManager;
let sim: GitHubSim;
let connectorId: string;

let prevApi: string | undefined;
let prevOAuth: string | undefined;
const issuedToken = 'gho_device_branch_token';

async function deviceStart(connector: string): Promise<Response> {
	return app.request(`/api/projects/${projectSlug}/connectors/${connector}/device/start`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
	});
}

async function devicePoll(connector: string, flowId: string): Promise<Response> {
	return app.request(`/api/projects/${projectSlug}/connectors/${connector}/device/poll`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ flow_id: flowId }),
	});
}

beforeAll(async () => {
	sim = await createGitHubSim();
	prevApi = process.env.GITHUB_API_BASE_URL;
	prevOAuth = process.env.GITHUB_OAUTH_BASE_URL;
	process.env.GITHUB_API_BASE_URL = sim.baseUrl;
	process.env.GITHUB_OAUTH_BASE_URL = sim.baseUrl;
	sim.seed({
		token: issuedToken,
		user: { id: 77, login: 'octo-branch', avatar_url: 'http://av/x.png', email: 'o@b' },
	});

	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const teamRes = await createTestTeam(db, { name: 'Device Branch Co' });
	teamId = (await teamRes.json()).data.id;
	projectSlug = await projectSlugFor(db, teamId);

	const { row } = await createOrFetchConnector(db, {
		name: 'github',
		displayName: 'GitHub',
		mcpUrl: 'https://api.githubcopilot.com/mcp/',
		mcpTransport: 'http',
	});
	connectorId = row.id;
});

afterAll(async () => {
	process.env.GITHUB_API_BASE_URL = prevApi;
	process.env.GITHUB_OAUTH_BASE_URL = prevOAuth;
	await sim.destroy();
	await safeClose(db);
});

describe('auth-start on a device-flow provider', () => {
	it('400s USE_DEVICE_FLOW — GitHub cannot go through the DCR auth-code path', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/auth-start`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ connector_id: connectorId }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe('USE_DEVICE_FLOW');
		expect(body.error.message).toMatch(/device flow/);
	});
});

describe('device/start', () => {
	it('503s DEVICE_START_FAILED when the device-code endpoint errors', async () => {
		const broken = await startBrokenStartSim();
		try {
			process.env.GITHUB_OAUTH_BASE_URL = broken.baseUrl;
			const res = await deviceStart(connectorId);
			expect(res.status).toBe(503);
			expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
				'DEVICE_START_FAILED',
			);
		} finally {
			process.env.GITHUB_OAUTH_BASE_URL = sim.baseUrl;
			await broken.destroy();
		}
	});

	it('returns flow id, user code, verification uri and polling interval', async () => {
		const res = await deviceStart(connectorId);
		expect(res.status).toBe(200);
		const { data } = (await res.json()) as {
			data: {
				flow_id: string;
				user_code: string;
				verification_uri: string;
				expires_in: number;
				interval: number;
			};
		};
		expect(data.flow_id).toMatch(/^[0-9a-f]{32}$/);
		expect(data.user_code).toMatch(/^USR-/);
		expect(data.verification_uri).toContain('/login/device');
		expect(data.expires_in).toBe(900);
		expect(data.interval).toBe(5);
	});
});

describe('device/poll branches', () => {
	it('202s pending with retry_after before the user approves', async () => {
		const start = await deviceStart(connectorId);
		const { data } = (await start.json()) as { data: { flow_id: string } };
		const res = await devicePoll(connectorId, data.flow_id);
		expect(res.status).toBe(202);
		const body = (await res.json()) as { data: { status: string; retry_after: number } };
		expect(body.data.status).toBe('pending');
		expect(body.data.retry_after).toBe(5);
	});

	it('400s DEVICE_FAILED when the provider reports a terminal error, deleting the flow', async () => {
		const start = await deviceStart(connectorId);
		const { data } = (await start.json()) as { data: { flow_id: string } };
		// The provider no longer knows the device code → expired_token.
		sim.state.deviceFlows.clear();
		const res = await devicePoll(connectorId, data.flow_id);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe('DEVICE_FAILED');
		expect(body.error.message).toBe('expired_token');
		// The flow entry was consumed — a re-poll is now unknown.
		const again = await devicePoll(connectorId, data.flow_id);
		expect(again.status).toBe(404);
	});

	it('400s when the connector loses its device capability mid-flow', async () => {
		const start = await deviceStart(connectorId);
		const { data } = (await start.json()) as { data: { flow_id: string } };
		await db.query(`UPDATE mcp_connections SET name = 'renamed-away' WHERE id = $1`, [connectorId]);
		try {
			const res = await devicePoll(connectorId, data.flow_id);
			expect(res.status).toBe(400);
			expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(
				/does not support the device flow/,
			);
		} finally {
			await db.query(`UPDATE mcp_connections SET name = 'github' WHERE id = $1`, [connectorId]);
		}
	});

	it('404s when the connector row was deleted after the flow started', async () => {
		const start = await deviceStart(connectorId);
		const { data } = (await start.json()) as { data: { flow_id: string } };
		await db.query(`DELETE FROM mcp_connections WHERE id = $1`, [connectorId]);
		const res = await devicePoll(connectorId, data.flow_id);
		expect(res.status).toBe(404);
		expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(
			/connector not found/,
		);
		// Recreate for the remaining tests.
		const { row } = await createOrFetchConnector(db, {
			name: 'github',
			displayName: 'GitHub',
			mcpUrl: 'https://api.githubcopilot.com/mcp/',
			mcpTransport: 'http',
		});
		connectorId = row.id;
	});

	it('503s DEVICE_FINALIZE_FAILED and marks the connector when identity resolution fails', async () => {
		const start = await deviceStart(connectorId);
		const { data } = (await start.json()) as { data: { flow_id: string; user_code: string } };
		// Approve with a token the GitHub API does not recognize → /user 401.
		sim.approveDeviceFlow(data.user_code, 'gho_not_the_right_token');
		const res = await devicePoll(connectorId, data.flow_id);
		expect(res.status).toBe(503);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
			'DEVICE_FINALIZE_FAILED',
		);
		const after = await getConnector(db, connectorId);
		expect(after?.auth_error).toMatch(/^finalize:/);
	});

	it('finalizes on approval: identity, secrets, SSH keys, active connector, wakeup', async () => {
		// Attribute the connector to the planning task so the finalize fires a
		// CredentialProvided wakeup at the task's assignee.
		const task = await db.query<{ id: string; assignee_id: string }>(
			`SELECT id, assignee_id FROM tasks
			 WHERE team_id = $1 AND assignee_id IS NOT NULL LIMIT 1`,
			[teamId],
		);
		expect(task.rows.length).toBe(1);
		await db.query(`UPDATE mcp_connections SET created_by_task_id = $1 WHERE id = $2`, [
			task.rows[0].id,
			connectorId,
		]);

		const start = await deviceStart(connectorId);
		const { data } = (await start.json()) as { data: { flow_id: string; user_code: string } };
		sim.approveDeviceFlow(data.user_code, issuedToken);

		const res = await devicePoll(connectorId, data.flow_id);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			data: { status: string; connection: { id: string; provider_account_label: string } };
		};
		expect(body.data.status).toBe('success');
		expect(body.data.connection.provider_account_label).toBe('octo-branch');

		// Real identity from the provider, registry scopes and hosts.
		const conn = await db.query<{
			provider: string;
			provider_account_id: string;
			scopes: string[];
			metadata: Record<string, unknown>;
		}>(
			`SELECT provider, provider_account_id, scopes, metadata
			 FROM oauth_connections WHERE id = $1`,
			[body.data.connection.id],
		);
		expect(conn.rows[0].provider).toBe('github');
		expect(conn.rows[0].provider_account_id).toBe('77');
		expect(conn.rows[0].scopes).toContain('repo');
		expect(conn.rows[0].metadata.connector_id).toBe(connectorId);
		expect(conn.rows[0].metadata.login).toBe('octo-branch');

		// GitHub hooks ran: the project key was registered for signing + auth.
		expect(sim.state.signingKeys.map((k) => k.title)).toEqual(['Hezo signing key']);
		expect(sim.state.authKeys.map((k) => k.title)).toEqual(['Hezo authentication key']);

		const after = await getConnector(db, connectorId);
		expect(after?.oauth_connection_id).toBe(body.data.connection.id);
		expect(after?.activated_at).toBeTruthy();

		// CredentialProvided wakeup fired at the requesting task's assignee
		// (fire-and-forget — poll briefly for the row).
		let wakeups: Array<{ member_id: string }> = [];
		for (let i = 0; i < 40 && wakeups.length === 0; i++) {
			const rows = await db.query<{ member_id: string }>(
				`SELECT member_id FROM agent_wakeup_requests
				 WHERE source = 'credential_provided'::wakeup_source AND team_id = $1`,
				[teamId],
			);
			wakeups = rows.rows;
			if (wakeups.length === 0) await new Promise((r) => setTimeout(r, 50));
		}
		expect(wakeups.length).toBeGreaterThan(0);
		expect(wakeups[0].member_id).toBe(task.rows[0].assignee_id);
	});

	it('re-connecting is idempotent: already-registered SSH keys are tolerated', async () => {
		// Second full connect for the same account: GitHub answers 422
		// "key is already in use" for both key kinds → already_exists branches.
		const start = await deviceStart(connectorId);
		const { data } = (await start.json()) as { data: { flow_id: string; user_code: string } };
		sim.approveDeviceFlow(data.user_code, issuedToken);
		const res = await devicePoll(connectorId, data.flow_id);
		expect(res.status).toBe(200);
		expect(((await res.json()) as { data: { status: string } }).data.status).toBe('success');
		// No duplicate keys were created.
		expect(sim.state.signingKeys.length).toBe(1);
		expect(sim.state.authKeys.length).toBe(1);
	});

	it('treats a failed afterConnect side effect (SSH key registration) as non-fatal', async () => {
		const broken = await startBrokenKeysGitHubSim();
		try {
			process.env.GITHUB_API_BASE_URL = broken.baseUrl;
			process.env.GITHUB_OAUTH_BASE_URL = broken.baseUrl;
			const start = await deviceStart(connectorId);
			expect(start.status).toBe(200);
			const { data } = (await start.json()) as { data: { flow_id: string } };
			// The broken sim auto-approves: the first poll succeeds despite the
			// key-registration 500s.
			const res = await devicePoll(connectorId, data.flow_id);
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				data: { status: string; connection: { provider_account_label: string } };
			};
			expect(body.data.status).toBe('success');
			expect(body.data.connection.provider_account_label).toBe('broken-keys-user');
			const after = await getConnector(db, connectorId);
			expect(after?.activated_at).toBeTruthy();
		} finally {
			process.env.GITHUB_API_BASE_URL = sim.baseUrl;
			process.env.GITHUB_OAUTH_BASE_URL = sim.baseUrl;
			await broken.destroy();
		}
	});
});

describe('mcp-callback finalize failure', () => {
	it('renders finalize_failed and marks the connector when identity resolution throws', async () => {
		// Exchange succeeds (github-sim issues the token for the code) but the
		// token is unknown to the GitHub API → fetchIdentity 401s inside finalize.
		sim.addCode('bad-code-1', 'gho_finalize_reject');
		const { state } = await signState(masterKeyManager, {
			teamId,
			provider: 'github',
			redirectUri: 'http://localhost/api/oauth/mcp-callback',
			returnTo: '/',
			mcpConnectionId: connectorId,
			manualConfig: {
				authorize_url: `${sim.baseUrl}/login/oauth/authorize`,
				token_url: `${sim.baseUrl}/login/oauth/access_token`,
				client_id: 'cb-client',
				scopes: ['repo'],
			},
		});
		const res = await app.request(
			`/api/oauth/mcp-callback?code=bad-code-1&state=${encodeURIComponent(state)}`,
		);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('finalize_failed');
		const after = await getConnector(db, connectorId);
		expect(after?.auth_error).toMatch(/^finalize:/);
	});
});
