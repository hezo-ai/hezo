import { createServer, type Server } from 'node:http';
import type { Hono } from 'hono';
import { Hono as HonoApp } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decrypt } from '../src/crypto/encryption';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

/**
 * Route coverage for the generic OAuth device-flow broker (`routes/oauth.ts`,
 * the `oauth-device/{start,poll}` pair): the api-connector guard, descriptor
 * validation, and the full acquisition → persist → link happy path against a
 * tiny local OAuth sim (no network). The device sim serves a device code and a
 * token endpoint that reports pending once, then issues an access + refresh
 * token so the broker persists the confidential-client creds host-side and
 * links + activates the api connector.
 */

interface LocalSim {
	baseUrl: string;
	tokenCalls: () => number;
	destroy(): Promise<void>;
}

async function startOAuthSim(): Promise<LocalSim> {
	let tokenCalls = 0;
	const app = new HonoApp();
	app.post('/device/code', (c) =>
		c.json({
			device_code: 'dev-code-1',
			user_code: 'BRK-CODE',
			verification_uri: 'http://localhost/device',
			expires_in: 900,
			interval: 1,
		}),
	);
	app.post('/token', async (c) => {
		tokenCalls++;
		// First poll: still pending. Second poll: issue the tokens.
		if (tokenCalls < 2) return c.json({ error: 'authorization_pending', interval: 1 });
		return c.json({
			access_token: 'ya29.brokeraccess',
			refresh_token: '1//brokerrefresh',
			expires_in: 3600,
			scope: 'https://www.googleapis.com/auth/youtube',
		});
	});
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
		tokenCalls: () => tokenCalls,
		destroy: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: MasterKeyManager;
let projectSlug: string;
let apiConnectorId: string;
let saasConnectorId: string;

const API_CONFIG = {
	base_url: 'https://www.googleapis.com',
	allowed_hosts: ['*.googleapis.com'],
	auth: { placement: 'header', name: 'Authorization', scheme: 'Bearer ' },
};

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const teamId = (await (await createTestTeam(db, { name: 'Broker Co' })).json()).data.id;
	const proj = (await (await createTestProject(db, teamId, { name: 'Broker Proj' })).json()).data;
	projectSlug = proj.slug;

	const api = await db.query<{ id: string }>(
		`INSERT INTO mcp_connections (name, kind, config, install_status, project_id)
		 VALUES ('youtube', 'api', $1::jsonb, 'installed', $2) RETURNING id`,
		[JSON.stringify(API_CONFIG), proj.id],
	);
	apiConnectorId = api.rows[0].id;

	const saas = await db.query<{ id: string }>(
		`INSERT INTO mcp_connections (name, kind, config, install_status, project_id)
		 VALUES ('linear', 'saas', '{"url":"https://mcp.linear.app"}'::jsonb, 'installed', $1) RETURNING id`,
		[proj.id],
	);
	saasConnectorId = saas.rows[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

function start(connectorId: string, body: Record<string, unknown>): Promise<Response> {
	return app.request(`/api/projects/${projectSlug}/connectors/${connectorId}/oauth-device/start`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
}

function poll(connectorId: string, flowId: string): Promise<Response> {
	return app.request(`/api/projects/${projectSlug}/connectors/${connectorId}/oauth-device/poll`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ flow_id: flowId }),
	});
}

describe('oauth-device/start guards', () => {
	it('404s an unknown connector', async () => {
		const res = await start('00000000-0000-0000-0000-000000000000', { client_id: 'x' });
		expect(res.status).toBe(404);
	});

	it('400s a non-api (saas) connector', async () => {
		const res = await start(saasConnectorId, { client_id: 'x', provider_id: 'google-youtube' });
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(
			/api connectors/,
		);
	});

	it('400s a missing client_id', async () => {
		const res = await start(apiConnectorId, { provider_id: 'google-youtube' });
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(
			/client_id/,
		);
	});

	it('400s an unknown provider_id', async () => {
		const res = await start(apiConnectorId, { provider_id: 'nope', client_id: 'x' });
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(
			/unknown provider_id/,
		);
	});
});

describe('oauth-device full acquisition', () => {
	it('acquires a token, persists host-only client creds, and links + activates the api connector', async () => {
		const sim = await startOAuthSim();
		try {
			const startRes = await start(apiConnectorId, {
				client_id: 'gcid.apps.googleusercontent.com',
				client_secret: 'GOCSPX-brokersecret',
				device_code_url: `${sim.baseUrl}/device/code`,
				token_url: `${sim.baseUrl}/token`,
				scopes: ['https://www.googleapis.com/auth/youtube'],
				allowed_hosts: ['*.googleapis.com'],
			});
			expect(startRes.status).toBe(200);
			const { data: startData } = (await startRes.json()) as {
				data: { flow_id: string; user_code: string };
			};
			expect(startData.user_code).toBe('BRK-CODE');

			// First poll: still pending (the sim reports authorization_pending once).
			const pending = await poll(apiConnectorId, startData.flow_id);
			expect(pending.status).toBe(202);
			expect(((await pending.json()) as { data: { status: string } }).data.status).toBe('pending');

			// Second poll: the sim issues the tokens → the broker finalizes.
			const success = await poll(apiConnectorId, startData.flow_id);
			expect(success.status).toBe(200);
			const { data: okData } = (await success.json()) as {
				data: { status: string; connection: { id: string; provider_account_label: string } };
			};
			expect(okData.status).toBe('success');
			const connId = okData.connection.id;

			// The oauth_connection persisted token_url + client_id (metadata) and a
			// client_secret_secret_id for host-side refresh.
			const conn = await db.query<{
				provider: string;
				metadata: Record<string, unknown>;
				client_secret_secret_id: string | null;
				expires_at: Date | null;
			}>(
				`SELECT provider, metadata, client_secret_secret_id, expires_at
				 FROM oauth_connections WHERE id = $1`,
				[connId],
			);
			expect(conn.rows[0].provider).toBe('oauth-broker');
			expect(conn.rows[0].metadata.token_url).toBe(`${sim.baseUrl}/token`);
			expect(conn.rows[0].metadata.client_id).toBe('gcid.apps.googleusercontent.com');
			expect(conn.rows[0].metadata.connector_id).toBe(apiConnectorId);
			expect(conn.rows[0].client_secret_secret_id).toBeTruthy();
			expect(conn.rows[0].expires_at).toBeTruthy();

			// The client secret is stored host-only (empty allowed_hosts) — never egress-substitutable.
			const key = masterKeyManager.getKey();
			if (!key) throw new Error('master key locked');
			const csSecret = await db.query<{ encrypted_value: string; allowed_hosts: string[] }>(
				`SELECT encrypted_value, allowed_hosts FROM secrets WHERE id = $1`,
				[conn.rows[0].client_secret_secret_id],
			);
			expect(csSecret.rows[0].allowed_hosts).toEqual([]);
			expect(decrypt(csSecret.rows[0].encrypted_value, key)).toBe('GOCSPX-brokersecret');

			// The api connector was linked + activated.
			const linked = await db.query<{ oauth_connection_id: string; activated_at: Date | null }>(
				`SELECT oauth_connection_id, activated_at FROM mcp_connections WHERE id = $1`,
				[apiConnectorId],
			);
			expect(linked.rows[0].oauth_connection_id).toBe(connId);
			expect(linked.rows[0].activated_at).toBeTruthy();

			// The flow entry was consumed — re-polling is now unknown.
			const again = await poll(apiConnectorId, startData.flow_id);
			expect(again.status).toBe(404);
		} finally {
			await sim.destroy();
		}
	});
});
