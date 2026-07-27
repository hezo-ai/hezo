import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import { type HezoCA, loadOrCreateCA } from '../src/services/egress/ca';
import { EgressProxy } from '../src/services/egress/proxy';
import { safeClose } from './helpers';
import { createTestApp, createTestProject, createTestTeam } from './helpers/app';

/**
 * The method allowlist enforced end-to-end through a live proxy.
 *
 * The pure decision rules live in `egress-mcp-method-guard.test.ts`; this file
 * covers the parts only a real proxy can show: that the restriction is resolved
 * per run, that an unrestricted run is completely untouched, and that a body too
 * large to inspect is rejected rather than waved through.
 */

let db: Db;
let proxy: EgressProxy;
let upstream: Server;
let upstreamHost: string;
let dataDir: string;
let ca: HezoCA;
let teamId: string;
let agentId: string;
let projectId: string;

/** Every request the fake MCP server actually received. Empty means blocked. */
const upstreamHits: Array<{ body: string }> = [];

let runSeq = 0;

async function startUpstream(): Promise<Server> {
	const server = createServer((req: IncomingMessage, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => chunks.push(c));
		req.on('end', () => {
			upstreamHits.push({ body: Buffer.concat(chunks).toString('utf8') });
			// Close the upstream socket explicitly: the proxy strips the client's
			// hop-by-hop `Connection: close` (correctly — it describes the
			// agent↔proxy hop), so without this the response socket lingers and each
			// request waits out a timeout instead of ending.
			res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
			res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return server;
}

/** POST a JSON body through the run's proxy to the fake MCP server. */
function postThroughProxy(
	port: number,
	body: string,
	contentType = 'application/json',
): Promise<{ status: number; body: string }> {
	const url = `http://${upstreamHost}/mcp`;
	const lines = [
		`POST ${url} HTTP/1.1`,
		`Host: ${upstreamHost}`,
		'Connection: close',
		`Content-Type: ${contentType}`,
		`Content-Length: ${Buffer.byteLength(body)}`,
	];
	const text = `${lines.join('\r\n')}\r\n\r\n${body}`;
	return new Promise((resolve, reject) => {
		const sock = connect({ host: '127.0.0.1', port });
		const chunks: Buffer[] = [];
		sock.on('connect', () => sock.write(text));
		sock.on('data', (c: Buffer) => chunks.push(c));
		sock.on('end', () => {
			const all = Buffer.concat(chunks).toString();
			const sep = all.indexOf('\r\n\r\n');
			const head = sep === -1 ? all : all.slice(0, sep);
			resolve({
				status: Number(head.split('\r\n')[0]?.split(' ')[1] ?? '0'),
				body: sep === -1 ? '' : all.slice(sep + 4),
			});
		});
		sock.on('error', reject);
		sock.setTimeout(20_000, () => sock.destroy(new Error('proxy fetch timed out')));
	});
}

/**
 * POST a chunked body (no Content-Length) through the run's proxy — the shape
 * `isBodySubstitutionEligible` deliberately skips, and so the one most likely to
 * slip past inspection if the MCP gate merely reused it.
 */
function postChunkedThroughProxy(
	port: number,
	body: string,
): Promise<{ status: number; body: string }> {
	const url = `http://${upstreamHost}/mcp`;
	const head = [
		`POST ${url} HTTP/1.1`,
		`Host: ${upstreamHost}`,
		'Connection: close',
		'Content-Type: application/json',
		'Transfer-Encoding: chunked',
	].join('\r\n');
	// One chunk, then the terminating zero-length chunk.
	const chunked = `${Buffer.byteLength(body).toString(16)}\r\n${body}\r\n0\r\n\r\n`;
	return new Promise((resolve, reject) => {
		const sock = connect({ host: '127.0.0.1', port });
		const chunks: Buffer[] = [];
		sock.on('connect', () => sock.write(`${head}\r\n\r\n${chunked}`));
		sock.on('data', (c: Buffer) => chunks.push(c));
		sock.on('end', () => {
			const all = Buffer.concat(chunks).toString();
			const sep = all.indexOf('\r\n\r\n');
			const headPart = sep === -1 ? all : all.slice(0, sep);
			resolve({
				status: Number(headPart.split('\r\n')[0]?.split(' ')[1] ?? '0'),
				body: sep === -1 ? '' : all.slice(sep + 4),
			});
		});
		sock.on('error', reject);
		sock.setTimeout(20_000, () => sock.destroy(new Error('proxy fetch timed out')));
	});
}

/** Insert an active saas connector pointed at the fake server. */
async function seedConnector(enabledMethods: string[] | null): Promise<void> {
	await db.query(
		`INSERT INTO mcp_connections (name, kind, config, install_status, project_id, activated_at, api_key_secret_id, enabled_methods)
		 VALUES ($1, 'saas', $2::jsonb, 'installed', $3, now(), NULL, $4::jsonb)`,
		[
			'tracker',
			JSON.stringify({ url: `http://${upstreamHost}/mcp` }),
			projectId,
			enabledMethods === null ? null : JSON.stringify(enabledMethods),
		],
	);
}

/** Allocate a fresh run proxy scoped to the test project. */
async function allocate(): Promise<{ port: number; release: () => Promise<void> }> {
	const runId = `mcp-guard-${++runSeq}`;
	const allocated = await proxy.allocateRunProxy(runId, { teamId, agentId, projectId });
	return {
		port: allocated.proxyPort,
		release: () => proxy.releaseRunProxy(runId),
	};
}

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	dataDir = mkdtempSync(join(tmpdir(), 'hezo-mcp-guard-'));

	const team = (await (await createTestTeam(db, { name: 'Guard Co' })).json()).data;
	teamId = team.id;
	const setup = (await (await createTestProject(db, teamId, { name: 'Setup' })).json()).data;
	const agentRes = await ctx.app.request(`/api/projects/${setup.slug}/agents`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Guard Agent' }),
	});
	agentId = (await agentRes.json()).data.id;
	projectId = (await (await createTestProject(db, teamId, { name: 'Work' })).json()).data.id;

	upstream = await startUpstream();
	upstreamHost = `127.0.0.1:${(upstream.address() as { port: number }).port}`;

	ca = await loadOrCreateCA(dataDir);
	proxy = new EgressProxy({ db, masterKeyManager: ctx.masterKeyManager, ca, authEnabled: false });
}, 30_000);

afterAll(async () => {
	await proxy.releaseAll();
	await new Promise<void>((resolve) => upstream.close(() => resolve()));
	await safeClose(db);
	rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
	upstreamHits.length = 0;
	await db.query('DELETE FROM mcp_connections');
});

describe('egress enforcement of a connector method allowlist', () => {
	it('forwards a call to an enabled method', async () => {
		await seedConnector(['get_issue', 'list_issues']);
		const run = await allocate();
		try {
			const res = await postThroughProxy(
				run.port,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'tools/call',
					params: { name: 'get_issue' },
				}),
			);
			expect(res.status).toBe(200);
			expect(upstreamHits.length).toBe(1);
		} finally {
			await run.release();
		}
	});

	it('blocks a call to a disabled method before it reaches the server', async () => {
		await seedConnector(['get_issue']);
		const run = await allocate();
		try {
			const res = await postThroughProxy(
				run.port,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'tools/call',
					params: { name: 'delete_issue' },
				}),
			);
			expect(res.status).toBe(403);
			expect(res.body).toContain('delete_issue');
			expect(res.body).toContain('tracker');
			// The point of the proxy leg: the request never reaches the server.
			expect(upstreamHits.length).toBe(0);
		} finally {
			await run.release();
		}
	});

	it('still forwards tools/list and initialize on a restricted connector', async () => {
		await seedConnector(['get_issue']);
		const run = await allocate();
		try {
			for (const method of ['initialize', 'tools/list']) {
				const res = await postThroughProxy(
					run.port,
					JSON.stringify({ jsonrpc: '2.0', id: 1, method }),
				);
				expect(res.status).toBe(200);
			}
			expect(upstreamHits.length).toBe(2);
		} finally {
			await run.release();
		}
	});

	it('leaves an unrestricted connector completely untouched', async () => {
		// enabled_methods NULL means no allowlist — the host must not even enter
		// the inspection path, so any method goes through.
		await seedConnector(null);
		const run = await allocate();
		try {
			const res = await postThroughProxy(
				run.port,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'tools/call',
					params: { name: 'delete_issue' },
				}),
			);
			expect(res.status).toBe(200);
			expect(upstreamHits.length).toBe(1);
		} finally {
			await run.release();
		}
	});

	it('does not restrict a host that no connector in this run covers', async () => {
		// A restricted connector on one host must not leak its allowlist onto
		// every other host the run talks to.
		await db.query(
			`INSERT INTO mcp_connections (name, kind, config, install_status, project_id, activated_at, enabled_methods)
			 VALUES ('other', 'saas', $1::jsonb, 'installed', $2, now(), $3::jsonb)`,
			[
				JSON.stringify({ url: 'http://elsewhere.invalid/mcp' }),
				projectId,
				JSON.stringify(['nothing']),
			],
		);
		const run = await allocate();
		try {
			const res = await postThroughProxy(
				run.port,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'tools/call',
					params: { name: 'delete_issue' },
				}),
			);
			expect(res.status).toBe(200);
			expect(upstreamHits.length).toBe(1);
		} finally {
			await run.release();
		}
	});

	it('fails closed on a body it cannot inspect', async () => {
		await seedConnector(['get_issue']);
		const run = await allocate();
		try {
			const res = await postThroughProxy(run.port, 'this is not json');
			expect(res.status).toBe(403);
			expect(upstreamHits.length).toBe(0);
		} finally {
			await run.release();
		}
	});

	it('rejects a restricted request too large to inspect rather than forwarding it', async () => {
		await seedConnector(['get_issue']);
		const run = await allocate();
		try {
			// Well past MAX_MCP_INSPECTION_BYTES (256 KB), and a disabled call is
			// buried in it — the size must not become a way around the allowlist.
			const filler = 'x'.repeat(300_000);
			const body = JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: { name: 'delete_issue', arguments: { blob: filler } },
			});
			const res = await postThroughProxy(run.port, body);
			expect(res.status).toBe(403);
			expect(upstreamHits.length).toBe(0);
		} finally {
			await run.release();
		}
	});

	it('forwards a large call to an enabled method, well past the substitution cap', async () => {
		// The inspection cap is deliberately far larger than the 8 KB substitution
		// cap: a real tools/call carries file contents and long issue bodies.
		await seedConnector(['save_issue']);
		const run = await allocate();
		try {
			const body = JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: { name: 'save_issue', arguments: { description: 'y'.repeat(50_000) } },
			});
			const res = await postThroughProxy(run.port, body);
			expect(res.status).toBe(200);
			expect(upstreamHits.length).toBe(1);
			// The body must arrive intact — buffering for inspection must not
			// truncate or re-encode it.
			expect(upstreamHits[0].body).toBe(body);
		} finally {
			await run.release();
		}
	});

	it('blocks a chunked call, which the substitution gate would have skipped', async () => {
		// isBodySubstitutionEligible requires a fixed Content-Length, so a chunked
		// body streams through unbuffered on the substitution path. The inspection
		// gate is deliberately wider — if it weren't, dropping Content-Length would
		// be a one-header bypass of the entire allowlist.
		await seedConnector(['get_issue']);
		const run = await allocate();
		try {
			const res = await postChunkedThroughProxy(
				run.port,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'tools/call',
					params: { name: 'delete_issue' },
				}),
			);
			expect(res.status).toBe(403);
			expect(upstreamHits.length).toBe(0);
		} finally {
			await run.release();
		}
	});

	it('forwards a chunked call to an enabled method, re-framed with a length', async () => {
		await seedConnector(['get_issue']);
		const run = await allocate();
		try {
			const body = JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: { name: 'get_issue' },
			});
			const res = await postChunkedThroughProxy(run.port, body);
			expect(res.status).toBe(200);
			expect(upstreamHits.length).toBe(1);
			// Buffering a chunked request means re-framing it; the payload the
			// server sees must still be byte-identical.
			expect(upstreamHits[0].body).toBe(body);
		} finally {
			await run.release();
		}
	});

	it('blocks a batch that hides one disabled call among enabled ones', async () => {
		await seedConnector(['get_issue']);
		const run = await allocate();
		try {
			const res = await postThroughProxy(
				run.port,
				JSON.stringify([
					{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_issue' } },
					{ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'delete_issue' } },
				]),
			);
			expect(res.status).toBe(403);
			expect(upstreamHits.length).toBe(0);
		} finally {
			await run.release();
		}
	});
});
