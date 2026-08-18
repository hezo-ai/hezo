import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import { connectorForPath, type McpHostBinding } from '../src/services/connectors/connections';
import { type HezoCA, loadOrCreateCA } from '../src/services/egress/ca';
import { type ConnectorRunRejection, EgressProxy } from '../src/services/egress/proxy';
import { safeClose } from './helpers';
import { createTestApp, createTestProject, createTestTeam } from './helpers/app';
import { rawRequestThroughProxy } from './helpers/egress-http';

/**
 * The egress proxy reporting a hosted connector's refusal of a run's request.
 *
 * What only a live proxy can show: that the report is attributed to the right
 * connector by host and path, that the credential shape it carries is what the
 * request had before substitution, that it fires once per shape per run, and
 * that neither the proxy's own answers nor another host's 401 are mistaken for
 * the connector refusing.
 */

let ctx: Awaited<ReturnType<typeof createTestApp>>;
let db: Db;
let proxy: EgressProxy;
let upstream: Server;
let upstreamHost: string;
let dataDir: string;
let ca: HezoCA;
let teamId: string;
let agentId: string;
let projectId: string;
let runSeq = 0;

/** The fake MCP server refuses `/mcp` and `/other`, serves everything else. */
async function startUpstream(): Promise<Server> {
	const server = createServer((req: IncomingMessage, res) => {
		req.resume();
		req.on('end', () => {
			const path = req.url ?? '/';
			const refused = path.startsWith('/mcp') || path.startsWith('/other');
			res.writeHead(refused ? 401 : 200, {
				'content-type': 'application/json',
				connection: 'close',
				...(refused ? { 'www-authenticate': 'Bearer error="invalid_token"' } : {}),
			});
			res.end(JSON.stringify(refused ? { error: 'unauthorized' } : { ok: true }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return server;
}

async function seedConnector(
	name: string,
	url: string,
	extra: { apiKeySecretId?: string; enabledMethods?: string[] } = {},
): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO mcp_connections (name, kind, config, install_status, project_id, activated_at, probed_at, api_key_secret_id, enabled_methods)
		 VALUES ($1, 'saas', $2::jsonb, 'installed', $3, now(), now(), $4, $5::jsonb) RETURNING id`,
		[
			name,
			JSON.stringify({ url }),
			projectId,
			extra.apiKeySecretId ?? null,
			extra.enabledMethods ? JSON.stringify(extra.enabledMethods) : null,
		],
	);
	return r.rows[0].id;
}

async function allocate(
	onConnectorRejection?: (event: ConnectorRunRejection) => void,
): Promise<{ port: number; runId: string; release: () => Promise<void> }> {
	const runId = `connector-rejection-${++runSeq}`;
	const allocated = await proxy.allocateRunProxy(runId, {
		teamId,
		agentId,
		projectId,
		...(onConnectorRejection ? { onConnectorRejection } : {}),
	});
	return { port: allocated.proxyPort, runId, release: () => proxy.releaseRunProxy(runId) };
}

function post(
	port: number,
	url: string,
	headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
	const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
	return rawRequestThroughProxy(port, {
		method: 'POST',
		url,
		headers: {
			'Content-Type': 'application/json',
			'Content-Length': String(Buffer.byteLength(body)),
			...headers,
		},
		body,
	});
}

/** Encrypt a value with the test instance's master key, as the vault would. */
async function encryptForTest(value: string): Promise<string> {
	const key = ctx.masterKeyManager.getKey();
	if (!key) throw new Error('test master key unavailable');
	const { encrypt } = await import('../src/crypto/encryption');
	return encrypt(value, key);
}

beforeAll(async () => {
	ctx = await createTestApp();
	db = ctx.db;
	dataDir = mkdtempSync(join(tmpdir(), 'hezo-connector-rejection-'));

	const team = (await (await createTestTeam(db, { name: 'Refusal Co' })).json()).data;
	teamId = team.id;
	const setup = (await (await createTestProject(db, teamId, { name: 'Setup' })).json()).data;
	const agentRes = await ctx.app.request(`/api/projects/${setup.slug}/agents`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Refusal Agent' }),
	});
	agentId = (await agentRes.json()).data.id;
	projectId = (await (await createTestProject(db, teamId, { name: 'Work' })).json()).data.id;

	upstream = await startUpstream();
	upstreamHost = `127.0.0.1:${(upstream.address() as { port: number }).port}`;

	ca = await loadOrCreateCA(dataDir);
	proxy = new EgressProxy({
		db,
		masterKeyManager: ctx.masterKeyManager,
		ca,
		authEnabled: false,
		allowPrivateTargets: true,
	});
}, 30_000);

afterAll(async () => {
	await proxy.releaseAll();
	await new Promise<void>((resolve) => upstream.close(() => resolve()));
	await safeClose(db);
	rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
	await db.query('DELETE FROM mcp_connections');
});

describe('a hosted connector refusing a run request', () => {
	it('is reported once, against the connector, with the shape the request had', async () => {
		const id = await seedConnector('ibkr', `http://${upstreamHost}/mcp`);
		const events: ConnectorRunRejection[] = [];
		const run = await allocate((e) => events.push(e));
		try {
			const first = await post(run.port, `http://${upstreamHost}/mcp`);
			expect(first.status).toBe(401);
			// A retry of the same shape is noise, not a second signal.
			const again = await post(run.port, `http://${upstreamHost}/mcp`);
			expect(again.status).toBe(401);
		} finally {
			await run.release();
		}
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			connectorId: id,
			connectorName: 'ibkr',
			credentialed: false,
			kind: 'upstream_rejected',
			status: 401,
			reason: 'http_401',
			credentialSent: false,
		});
	});

	it('records whether the request carried a placeholder, and reports each shape once', async () => {
		const secret = await db.query<{ id: string }>(
			`INSERT INTO secrets (name, encrypted_value, category, allowed_hosts)
			 VALUES ('MCP_IBKR_KEY', $1, 'api_token'::secret_category, '{127.0.0.1}') RETURNING id`,
			[await encryptForTest('live-key-abc')],
		);
		await seedConnector('ibkr', `http://${upstreamHost}/mcp`, {
			apiKeySecretId: secret.rows[0].id,
		});
		const events: ConnectorRunRejection[] = [];
		const run = await allocate((e) => events.push(e));
		try {
			// The runtime dropped the header: no placeholder anywhere.
			await post(run.port, `http://${upstreamHost}/mcp`);
			// The runtime sent it, but as a name the vault does not know - the
			// proxy answers that itself, before any upstream, and says so.
			const failed = await post(run.port, `http://${upstreamHost}/mcp`, {
				Authorization: 'Bearer __HEZO_SECRET_NOT_A_SECRET__',
			});
			expect(failed.status).toBe(400);
			await post(run.port, `http://${upstreamHost}/mcp`, {
				Authorization: 'Bearer __HEZO_SECRET_NOT_A_SECRET__',
			});
		} finally {
			await run.release();
		}
		expect(events).toHaveLength(2);
		expect(events[0]).toMatchObject({
			kind: 'upstream_rejected',
			credentialed: true,
			credentialSent: false,
			status: 401,
		});
		expect(events[1]).toMatchObject({
			kind: 'substitution_failed',
			credentialed: true,
			credentialSent: true,
			reason: 'unknown_secret',
		});
		expect(events[1].detail).toContain('NOT_A_SECRET');
	});

	it('ignores a 401 on a path no connector covers, or a host no connector names', async () => {
		await seedConnector('ibkr', `http://${upstreamHost}/mcp`);
		const events: ConnectorRunRejection[] = [];
		const run = await allocate((e) => events.push(e));
		try {
			expect((await post(run.port, `http://${upstreamHost}/other`)).status).toBe(401);
			// Shares the connector path's first characters but not its segment: the
			// server refuses it all the same, and it is still not the connector's.
			expect((await post(run.port, `http://${upstreamHost}/mcp-unrelated`)).status).toBe(401);
			// The same server under a name no connector is configured with: not the
			// connector's host as far as the run is concerned.
			const port = upstreamHost.split(':')[1];
			expect((await post(run.port, `http://localhost:${port}/mcp`)).status).toBe(401);
		} finally {
			await run.release();
		}
		expect(events).toEqual([]);
	});

	it('reports a connector whose upstream never answers as unreachable', async () => {
		const dead = createServer();
		await new Promise<void>((resolve) => dead.listen(0, '127.0.0.1', resolve));
		const deadPort = (dead.address() as { port: number }).port;
		await new Promise<void>((resolve) => dead.close(() => resolve()));
		await seedConnector('ghost', `http://127.0.0.1:${deadPort}/mcp`);
		const events: ConnectorRunRejection[] = [];
		const run = await allocate((e) => events.push(e));
		try {
			const res = await post(run.port, `http://127.0.0.1:${deadPort}/mcp`);
			expect(res.status).toBe(502);
		} finally {
			await run.release();
		}
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			connectorName: 'ghost',
			kind: 'upstream_unreachable',
			status: 0,
			reason: 'ECONNREFUSED',
		});
	});

	it("does not mistake the proxy's own method-allowlist refusal for the connector's", async () => {
		await seedConnector('tracker', `http://${upstreamHost}/mcp`, { enabledMethods: ['get_issue'] });
		const events: ConnectorRunRejection[] = [];
		const run = await allocate((e) => events.push(e));
		try {
			const body = JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: { name: 'delete_issue' },
			});
			const res = await rawRequestThroughProxy(run.port, {
				method: 'POST',
				url: `http://${upstreamHost}/mcp`,
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': String(Buffer.byteLength(body)),
				},
				body,
			});
			expect(res.status).toBe(403);
		} finally {
			await run.release();
		}
		expect(events).toEqual([]);
	});

	it('is silent, and harmless, for a run that supplied no callback', async () => {
		await seedConnector('ibkr', `http://${upstreamHost}/mcp`);
		const run = await allocate();
		try {
			expect((await post(run.port, `http://${upstreamHost}/mcp`)).status).toBe(401);
		} finally {
			await run.release();
		}
	});
});

describe('connectorForPath', () => {
	const binding = (paths: string[]): McpHostBinding => ({
		connectors: paths
			.map((pathname, i) => ({ id: `c${i}`, name: `c${i}`, pathname, credentialed: false }))
			.sort((a, b) => b.pathname.length - a.pathname.length),
		restriction: null,
	});

	it('matches the configured path, its sub-paths and a query string, segment-wise', () => {
		const b = binding(['/mcp']);
		expect(connectorForPath(b, '/mcp')?.pathname).toBe('/mcp');
		expect(connectorForPath(b, '/mcp/')?.pathname).toBe('/mcp');
		expect(connectorForPath(b, '/mcp/messages?sessionId=1')?.pathname).toBe('/mcp');
		expect(connectorForPath(b, '/mcpx')).toBeNull();
		expect(connectorForPath(b, '/')).toBeNull();
	});

	it('prefers the longest prefix and lets a root connector claim everything', () => {
		const b = binding(['/', '/v1/api/mcp']);
		expect(connectorForPath(b, '/v1/api/mcp/session')?.pathname).toBe('/v1/api/mcp');
		expect(connectorForPath(b, '/anything/else')?.pathname).toBe('/');
	});
});
