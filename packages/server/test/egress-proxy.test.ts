import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encrypt } from '../src/crypto/encryption';
import type { MasterKeyManager } from '../src/crypto/master-key';
import { type HezoCA, loadOrCreateCA } from '../src/services/egress/ca';
import { PortAllocator } from '../src/services/egress/port-allocator';
import { EgressProxy } from '../src/services/egress/proxy';
import { safeClose } from './helpers';
import { createTestApp, createTestProject } from './helpers/app';

let db: PGlite;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let agentId: string;
let proxy: EgressProxy;
let upstream: Server;
let upstreamUrl: string;
let dataDir: string;
let ca: HezoCA;

interface UpstreamRequest {
	method: string;
	url: string;
	headers: Record<string, string | string[] | undefined>;
	body: string;
}

const upstreamRequests: UpstreamRequest[] = [];
const httpsUpstreamHits: UpstreamRequest[] = [];

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	masterKeyManager = ctx.masterKeyManager;
	dataDir = mkdtempSync(join(tmpdir(), 'hezo-egress-proxy-'));

	const teamRes = await ctx.app.request('/api/teams', {
		method: 'POST',
		headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Egress Co' }),
	});
	const team = (await teamRes.json()).data;
	teamId = team.id;
	const projectSlug = (
		await (await createTestProject(db, teamId, { name: 'Setup Project' })).json()
	).data.slug;
	const agentRes = await ctx.app.request(`/api/projects/${projectSlug}/agents`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Egress Agent' }),
	});
	agentId = (await agentRes.json()).data.id;

	upstream = await startUpstream();
	upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;

	ca = await loadOrCreateCA(dataDir);
	proxy = new EgressProxy({ db, masterKeyManager, ca });
}, 30_000);

afterAll(async () => {
	await proxy.releaseAll();
	await new Promise<void>((resolve) => upstream.close(() => resolve()));
	await safeClose(db);
	rmSync(dataDir, { recursive: true, force: true });
});

describe('EgressProxy', () => {
	it('substitutes a header placeholder with the matching secret on an allowed host', async () => {
		const runId = `run-${Date.now()}-1`;
		await insertSecret('TEST_KEY_HEADER', 'real-header-value', ['127.0.0.1']);
		const allocated = await proxy.allocateRunProxy(runId, { teamId, agentId });
		try {
			const res = await fetchThroughProxy({
				proxyHost: '127.0.0.1',
				proxyPort: allocated.proxyPort,
				url: `${upstreamUrl}/echo`,
				headers: { authorization: 'Bearer __HEZO_SECRET_TEST_KEY_HEADER__' },
			});
			expect(res.status).toBe(200);
			const lastReq = upstreamRequests.at(-1);
			expect(lastReq?.headers.authorization).toBe('Bearer real-header-value');
		} finally {
			await proxy.releaseRunProxy(runId);
		}
		const audit = await db.query(
			`SELECT details FROM audit_log WHERE entity_type = 'egress_request' AND details->>'run_id' = $1 ORDER BY created_at DESC LIMIT 1`,
			[runId],
		);
		expect(audit.rows.length).toBe(1);
		const details = (audit.rows[0] as { details: Record<string, unknown> }).details;
		expect(details.substitutions_count).toBe(1);
		expect(details.secret_names_used).toEqual(['TEST_KEY_HEADER']);
		expect(details.error).toBeNull();
	}, 30_000);

	it('blocks a placeholder for a host that is not on its allowlist with 403', async () => {
		const runId = `run-${Date.now()}-2`;
		await insertSecret('TEST_KEY_RESTRICTED', 'never-leaked', ['only.example']);
		const allocated = await proxy.allocateRunProxy(runId, { teamId, agentId });
		try {
			const res = await fetchThroughProxy({
				proxyHost: '127.0.0.1',
				proxyPort: allocated.proxyPort,
				url: `${upstreamUrl}/echo`,
				headers: { authorization: 'Bearer __HEZO_SECRET_TEST_KEY_RESTRICTED__' },
			});
			expect(res.status).toBe(403);
			const body = JSON.parse(res.body);
			expect(body.error).toBe('secret_not_allowed_for_host');
			// Upstream must NOT have seen the placeholder OR the value
			for (const req of upstreamRequests) {
				expect(req.headers.authorization?.toString().includes('never-leaked')).not.toBe(true);
			}
		} finally {
			await proxy.releaseRunProxy(runId);
		}
	}, 30_000);

	it('rejects an unknown placeholder with 400 unknown_secret', async () => {
		const runId = `run-${Date.now()}-3`;
		const allocated = await proxy.allocateRunProxy(runId, { teamId, agentId });
		try {
			const res = await fetchThroughProxy({
				proxyHost: '127.0.0.1',
				proxyPort: allocated.proxyPort,
				url: `${upstreamUrl}/echo`,
				headers: { authorization: 'Bearer __HEZO_SECRET_DOES_NOT_EXIST__' },
			});
			expect(res.status).toBe(400);
			expect(JSON.parse(res.body).error).toBe('unknown_secret');
		} finally {
			await proxy.releaseRunProxy(runId);
		}
	}, 30_000);

	it('forwards request bodies unchanged (no body substitution by design)', async () => {
		const runId = `run-${Date.now()}-4`;
		const allocated = await proxy.allocateRunProxy(runId, { teamId, agentId });
		try {
			const body = '{"plain":"json","number":42}';
			const res = await fetchThroughProxy({
				proxyHost: '127.0.0.1',
				proxyPort: allocated.proxyPort,
				url: `${upstreamUrl}/echo`,
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body,
			});
			expect(res.status).toBe(200);
			const lastReq = upstreamRequests.at(-1);
			expect(lastReq?.body).toBe(body);
		} finally {
			await proxy.releaseRunProxy(runId);
		}
	}, 30_000);

	it('passes plain requests through untouched and writes a no-substitution audit row', async () => {
		const runId = `run-${Date.now()}-5`;
		const allocated = await proxy.allocateRunProxy(runId, { teamId, agentId });
		try {
			const res = await fetchThroughProxy({
				proxyHost: '127.0.0.1',
				proxyPort: allocated.proxyPort,
				url: `${upstreamUrl}/echo`,
				headers: { 'x-test': 'plain-value' },
			});
			expect(res.status).toBe(200);
			const lastReq = upstreamRequests.at(-1);
			expect(lastReq?.headers['x-test']).toBe('plain-value');
		} finally {
			await proxy.releaseRunProxy(runId);
		}
	}, 30_000);

	it('terminates HTTPS via the internal MITM server and substitutes a header placeholder', async () => {
		// Exercises the CONNECT → internal MITM TLS server path. The agent's TLS
		// terminates on a proxy-minted leaf (signed by the Hezo CA), the
		// placeholder is substituted, then the request is re-encrypted to the
		// upstream — all without a container.
		const httpsProxy = new EgressProxy({
			db,
			masterKeyManager,
			ca,
			extraUpstreamTrustedCAs: ca.cert,
		});
		const httpsUpstream = await startHttpsUpstream(ca);
		const httpsPort = (httpsUpstream.address() as { port: number }).port;
		const runId = `run-${Date.now()}-https`;
		await insertSecret('TEST_HTTPS_HEADER', 'real-https-value', ['localhost']);
		const allocated = await httpsProxy.allocateRunProxy(runId, { teamId, agentId });
		try {
			const res = await fetchHttpsThroughProxy({
				proxyHost: '127.0.0.1',
				proxyPort: allocated.proxyPort,
				targetHost: 'localhost',
				targetPort: httpsPort,
				path: '/echo',
				headers: { authorization: 'Bearer __HEZO_SECRET_TEST_HTTPS_HEADER__' },
				caCert: ca.cert,
			});
			expect(res.status).toBe(200);
			const lastHit = httpsUpstreamHits.at(-1);
			expect(lastHit?.headers.authorization).toBe('Bearer real-https-value');
		} finally {
			await httpsProxy.releaseRunProxy(runId);
			await new Promise<void>((resolve) => httpsUpstream.close(() => resolve()));
		}
		const audit = await db.query(
			`SELECT details FROM audit_log WHERE entity_type = 'egress_request' AND details->>'run_id' = $1 ORDER BY created_at DESC LIMIT 1`,
			[runId],
		);
		expect(audit.rows.length).toBe(1);
		const details = (audit.rows[0] as { details: Record<string, unknown> }).details;
		expect(details.substitutions_count).toBe(1);
	}, 30_000);
});

interface ProxyFetchOpts {
	proxyHost: string;
	proxyPort: number;
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string;
}

async function fetchThroughProxy(opts: ProxyFetchOpts): Promise<{ status: number; body: string }> {
	const target = new URL(opts.url);
	const _path = `${target.pathname}${target.search}`;
	const headerLines = [
		`${opts.method ?? 'GET'} ${opts.url} HTTP/1.1`,
		`Host: ${target.host}`,
		'Connection: close',
		...Object.entries(opts.headers ?? {}).map(([k, v]) => `${k}: ${v}`),
	];
	if (opts.body !== undefined) {
		headerLines.push(`Content-Length: ${Buffer.byteLength(opts.body)}`);
	}
	const requestText = `${headerLines.join('\r\n')}\r\n\r\n${opts.body ?? ''}`;

	const { connect } = await import('node:net');
	return new Promise((resolve, reject) => {
		const sock = connect({ host: opts.proxyHost, port: opts.proxyPort });
		const chunks: Buffer[] = [];
		sock.on('connect', () => sock.write(requestText));
		sock.on('data', (chunk: Buffer) => chunks.push(chunk));
		sock.on('end', () => {
			const all = Buffer.concat(chunks).toString();
			const sep = all.indexOf('\r\n\r\n');
			const headPart = sep === -1 ? all : all.slice(0, sep);
			const body = sep === -1 ? '' : all.slice(sep + 4);
			const statusLine = headPart.split('\r\n')[0] ?? '';
			const status = Number(statusLine.split(' ')[1] ?? '0');
			resolve({ status, body });
		});
		sock.on('error', reject);
		sock.setTimeout(20_000, () => {
			sock.destroy(new Error('proxy fetch timed out'));
		});
	});
}

async function insertSecret(name: string, value: string, allowedHosts: string[]): Promise<void> {
	const key = masterKeyManager.getKey();
	if (!key) throw new Error('master key unavailable in test');
	const enc = encrypt(value, key);
	await db.query(
		`INSERT INTO secrets (name, encrypted_value, category, allowed_hosts)
		 VALUES ($1, $2, 'api_token'::secret_category, $3)
		 ON CONFLICT (name) DO UPDATE
		 SET encrypted_value = EXCLUDED.encrypted_value,
		     allowed_hosts = EXCLUDED.allowed_hosts`,
		[name, enc, allowedHosts],
	);
}

async function startUpstream(): Promise<Server> {
	const server = createServer((req: IncomingMessage, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk) => chunks.push(chunk));
		req.on('end', () => {
			upstreamRequests.push({
				method: req.method ?? 'GET',
				url: req.url ?? '',
				headers: req.headers as Record<string, string | string[] | undefined>,
				body: Buffer.concat(chunks).toString(),
			});
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(
				JSON.stringify({
					ok: true,
					seen: { method: req.method, headers: req.headers, path: req.url },
				}),
			);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
	return server;
}

async function startHttpsUpstream(rootCa: { cert: string; key: string }): Promise<HttpsServer> {
	const { createServer: createHttpsServer } = await import('node:https');
	const { mintCertFromCA } = await import('./helpers/self-signed-cert');
	const { cert, key } = await mintCertFromCA(rootCa, 'localhost');
	const server = createHttpsServer({ cert, key }, (req: IncomingMessage, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk) => chunks.push(chunk));
		req.on('end', () => {
			httpsUpstreamHits.push({
				method: req.method ?? 'GET',
				url: req.url ?? '',
				headers: req.headers as Record<string, string | string[] | undefined>,
				body: Buffer.concat(chunks).toString(),
			});
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ ok: true }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
	return server;
}

interface HttpsProxyFetchOpts {
	proxyHost: string;
	proxyPort: number;
	targetHost: string;
	targetPort: number;
	path: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	caCert: string;
}

async function fetchHttpsThroughProxy(
	opts: HttpsProxyFetchOpts,
): Promise<{ status: number; body: string }> {
	const { connect: netConnect } = await import('node:net');
	const { connect: tlsConnect } = await import('node:tls');

	const tunnel = await new Promise<Socket>((resolve, reject) => {
		const sock = netConnect({ host: opts.proxyHost, port: opts.proxyPort });
		const onData = (chunk: Buffer) => {
			const statusLine = chunk.toString().split('\r\n')[0] ?? '';
			sock.removeListener('data', onData);
			if (/^HTTP\/1\.[01] 200/.test(statusLine)) {
				resolve(sock);
			} else {
				reject(new Error(`CONNECT failed: ${statusLine}`));
			}
		};
		sock.on('connect', () => {
			sock.write(
				`CONNECT ${opts.targetHost}:${opts.targetPort} HTTP/1.1\r\n` +
					`Host: ${opts.targetHost}:${opts.targetPort}\r\n\r\n`,
			);
		});
		sock.on('data', onData);
		sock.on('error', reject);
		sock.setTimeout(20_000, () => sock.destroy(new Error('CONNECT timed out')));
	});

	return new Promise((resolve, reject) => {
		const tls = tlsConnect(
			{ socket: tunnel, servername: opts.targetHost, ca: [opts.caCert] },
			() => {
				const headerLines = [
					`${opts.method ?? 'GET'} ${opts.path} HTTP/1.1`,
					`Host: ${opts.targetHost}:${opts.targetPort}`,
					'Connection: close',
					...Object.entries(opts.headers ?? {}).map(([k, v]) => `${k}: ${v}`),
				];
				if (opts.body !== undefined) {
					headerLines.push(`Content-Length: ${Buffer.byteLength(opts.body)}`);
				}
				tls.write(`${headerLines.join('\r\n')}\r\n\r\n${opts.body ?? ''}`);
			},
		);
		const chunks: Buffer[] = [];
		tls.on('data', (chunk: Buffer) => chunks.push(chunk));
		tls.on('end', () => {
			const all = Buffer.concat(chunks).toString();
			const sep = all.indexOf('\r\n\r\n');
			const headPart = sep === -1 ? all : all.slice(0, sep);
			const body = sep === -1 ? '' : all.slice(sep + 4);
			const statusLine = headPart.split('\r\n')[0] ?? '';
			const status = Number(statusLine.split(' ')[1] ?? '0');
			resolve({ status, body });
		});
		tls.on('error', reject);
		tls.setTimeout(20_000, () => tls.destroy(new Error('https fetch timed out')));
	});
}

/** Open a CONNECT tunnel for `targetHost`, complete the client↔proxy TLS
 * handshake, and return a descriptor of the leaf cert the proxy served (CN +
 * subjectAltName). No upstream is contacted, so the host need not resolve. */
async function servedCertThroughProxy(
	proxyPort: number,
	targetHost: string,
	caCert: string,
): Promise<string> {
	const { connect: netConnect } = await import('node:net');
	const { connect: tlsConnect } = await import('node:tls');

	const tunnel = await new Promise<Socket>((resolve, reject) => {
		const sock = netConnect({ host: '127.0.0.1', port: proxyPort });
		const onData = (chunk: Buffer) => {
			const statusLine = chunk.toString().split('\r\n')[0] ?? '';
			sock.removeListener('data', onData);
			if (/^HTTP\/1\.[01] 200/.test(statusLine)) resolve(sock);
			else reject(new Error(`CONNECT failed: ${statusLine}`));
		};
		sock.on('connect', () => {
			sock.write(`CONNECT ${targetHost}:443 HTTP/1.1\r\nHost: ${targetHost}:443\r\n\r\n`);
		});
		sock.on('data', onData);
		sock.on('error', reject);
		sock.setTimeout(20_000, () => sock.destroy(new Error('CONNECT timed out')));
	});

	return new Promise<string>((resolve, reject) => {
		const tls = tlsConnect(
			{ socket: tunnel, servername: targetHost, ca: [caCert], rejectUnauthorized: false },
			() => {
				const peer = tls.getPeerCertificate();
				const descriptor = `${peer.subject?.CN ?? ''} ${peer.subjectaltname ?? ''}`;
				tls.end();
				resolve(descriptor);
			},
		);
		tls.on('error', reject);
		tls.setTimeout(20_000, () => tls.destroy(new Error('tls handshake timed out')));
	});
}

/** Reach into the proxy's per-run internals and close the live per-host server
 * for a hostname, leaving a stale map entry — the production death scenario. */
async function killHostServer(proxy: EgressProxy, runId: string, host: string): Promise<void> {
	const runs = (
		proxy as unknown as {
			runs: Map<string, { hostServers: Map<string, { server: HttpsServer }> }>;
		}
	).runs;
	const server = runs.get(runId)?.hostServers.get(host)?.server;
	if (!server) throw new Error(`no per-host server for ${host}`);
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Reach into the proxy's per-run per-host server map for port assertions. */
function hostServersOf(
	proxy: EgressProxy,
	runId: string,
): Map<string, { server: HttpsServer; port: number }> {
	const runs = (
		proxy as unknown as {
			runs: Map<string, { hostServers: Map<string, { server: HttpsServer; port: number }> }>;
		}
	).runs;
	return runs.get(runId)?.hostServers ?? new Map();
}

describe('EgressProxy per-host cert routing', () => {
	// Each upstream host the agent reaches over TLS gets its own minted leaf
	// cert served from a dedicated internal server. A connection for one host
	// must always be served that host's cert — never a stale or recycled one.
	it('serves each concurrent host its own leaf cert (no cross-host mix-up)', async () => {
		const httpsProxy = new EgressProxy({
			db,
			masterKeyManager,
			ca,
			extraUpstreamTrustedCAs: ca.cert,
		});
		const runId = `run-${Date.now()}-multihost`;
		const allocated = await httpsProxy.allocateRunProxy(runId, { teamId, agentId });
		const hosts = ['hosta.egress-test', 'hostb.egress-test', 'hostc.egress-test'];
		try {
			const certs = await Promise.all(
				hosts.map((h) => servedCertThroughProxy(allocated.proxyPort, h, ca.cert)),
			);
			for (let i = 0; i < hosts.length; i++) {
				expect(certs[i]).toContain(hosts[i]);
			}
		} finally {
			await httpsProxy.releaseRunProxy(runId);
		}
	}, 30_000);

	// Locks the root-cause fix: each per-host server must bind a port handed out
	// by the host allocator, never one read back from `server.address()` (which
	// lies under Bun, collapsing every host onto one port and serving the wrong
	// leaf cert). Inject an allocator with a known sequence and assert each host's
	// recorded port is exactly what was allocated — a revert to `listen(0)` +
	// `address()` would record arbitrary ephemeral ports instead and fail here.
	it('binds each per-host server to its allocated port, not an address()-derived one', async () => {
		const portA = await reserveFreePort();
		const portB = await reserveFreePort();
		class SeqHostAllocator extends PortAllocator {
			private readonly seq = [portA, portB];
			private i = 0;
			async allocate(): Promise<number> {
				const p = this.seq[this.i++];
				if (p === undefined) throw new Error('SeqHostAllocator exhausted');
				return p;
			}
			release(): void {}
		}
		const hostProxy = new EgressProxy({
			db,
			masterKeyManager,
			ca,
			extraUpstreamTrustedCAs: ca.cert,
			hostPortAllocator: new SeqHostAllocator(),
		});
		const runId = `run-${Date.now()}-hostports`;
		const allocated = await hostProxy.allocateRunProxy(runId, { teamId, agentId });
		try {
			const a = await servedCertThroughProxy(allocated.proxyPort, 'hosta.egress-test', ca.cert);
			const b = await servedCertThroughProxy(allocated.proxyPort, 'hostb.egress-test', ca.cert);
			expect(a).toContain('hosta.egress-test');
			expect(b).toContain('hostb.egress-test');
			const map = hostServersOf(hostProxy, runId);
			expect(map.get('hosta.egress-test')?.port).toBe(portA);
			expect(map.get('hostb.egress-test')?.port).toBe(portB);
			expect(portA).not.toBe(portB);
		} finally {
			await hostProxy.releaseRunProxy(runId);
		}
	}, 30_000);

	// The production incident: a per-host internal server dies mid-run while the
	// hostname is still routed to it. The next connection must rebuild a live
	// server and serve the correct cert — never dial a dead loopback port
	// (ECONNREFUSED) for the rest of the run.
	it('rebuilds a per-host server after it dies and still serves the right cert', async () => {
		const httpsProxy = new EgressProxy({
			db,
			masterKeyManager,
			ca,
			extraUpstreamTrustedCAs: ca.cert,
		});
		const runId = `run-${Date.now()}-rebuild`;
		const host = 'registry.egress-test';
		const allocated = await httpsProxy.allocateRunProxy(runId, { teamId, agentId });
		try {
			const first = await servedCertThroughProxy(allocated.proxyPort, host, ca.cert);
			expect(first).toContain(host);

			// Kill the live per-host server behind this hostname; its entry is now
			// stale (server closed, port free to recycle).
			await killHostServer(httpsProxy, runId, host);

			const second = await servedCertThroughProxy(allocated.proxyPort, host, ca.cert);
			expect(second).toContain(host);
		} finally {
			await httpsProxy.releaseRunProxy(runId);
		}
	}, 30_000);

	// A candidate port can pass the allocator's free-probe yet lose the race to
	// bind (a parallel process grabs it first). Allocation must try the next port
	// rather than fail the whole run.
	it('retries onto another port when a candidate loses the bind race', async () => {
		const occupied = createNetServer();
		const occupiedPort = await new Promise<number>((resolve, reject) => {
			occupied.once('error', reject);
			occupied.listen(0, '127.0.0.1', () => resolve((occupied.address() as { port: number }).port));
		});
		const freePort = await reserveFreePort();

		class FixedAllocator extends PortAllocator {
			private i = 0;
			private readonly seq = [occupiedPort, freePort];
			async allocate(): Promise<number> {
				return this.seq[this.i++];
			}
			release(): void {}
		}

		const retryProxy = new EgressProxy({
			db,
			masterKeyManager,
			ca,
			portAllocator: new FixedAllocator(),
		});
		const runId = `run-${Date.now()}-bind-retry`;
		try {
			const allocated = await retryProxy.allocateRunProxy(runId, { teamId, agentId });
			expect(allocated.proxyPort).toBe(freePort);
		} finally {
			await retryProxy.releaseRunProxy(runId);
			await new Promise<void>((r) => occupied.close(() => r()));
		}
	});
});

function reserveFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const s: NetServer = createNetServer();
		s.once('error', reject);
		s.listen(0, '127.0.0.1', () => {
			const port = (s.address() as { port: number }).port;
			s.close(() => resolve(port));
		});
	});
}
