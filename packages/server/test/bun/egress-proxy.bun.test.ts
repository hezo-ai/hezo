import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import type { PGlite } from '@electric-sql/pglite';
import { encrypt } from '../../src/crypto/encryption';
import type { MasterKeyManager } from '../../src/crypto/master-key';
import { type HezoCA, loadOrCreateCA } from '../../src/services/egress/ca';
import { EgressProxy } from '../../src/services/egress/proxy';
import { createTestApp, createTestProject } from '../helpers/app';
import { mintCertFromCA } from '../helpers/self-signed-cert';

// Runtime tier: this spec runs under `bun test`, exercising the egress proxy on
// the production Bun runtime rather than the Node runtime that vitest uses. It
// guards the HTTPS MITM path — Bun's https.Server lacks addContext and ignores
// SNICallback, so any single-server SNI scheme (e.g. forceSNI) silently breaks
// here even though it passes under Node/vitest.

let db: PGlite;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let agentId: string;
let ca: HezoCA;
let dataDir: string;
let proxy: EgressProxy;

// CA generation alone takes ~2s; on slow CI runners the full setup (PGlite +
// Hono boot + three API calls + CA + proxy) can push past Bun's 5s default
// hook timeout. Give the same headroom as the tests themselves.
beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	masterKeyManager = ctx.masterKeyManager;
	dataDir = mkdtempSync(join(tmpdir(), 'hezo-egress-bun-'));

	const teamRes = await ctx.app.request('/api/teams', {
		method: 'POST',
		headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Egress Bun Co' }),
	});
	const teamData = (await teamRes.json()).data;
	teamId = teamData.id;
	const projectSlug = (
		await (await createTestProject(db, teamId, { name: 'Setup Project' })).json()
	).data.slug;
	const agentRes = await ctx.app.request(`/api/projects/${projectSlug}/agents`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Egress Bun Agent' }),
	});
	agentId = (await agentRes.json()).data.id;

	ca = await loadOrCreateCA(dataDir);
	proxy = new EgressProxy({ db, masterKeyManager, ca, extraUpstreamTrustedCAs: ca.cert });
}, 60_000);

afterAll(async () => {
	await proxy.releaseAll();
	rmSync(dataDir, { recursive: true, force: true });
	await db.close();
});

describe('EgressProxy under Bun', () => {
	test('terminates HTTPS through the MITM path and substitutes a header placeholder', async () => {
		const upstream = await startHttpsUpstream(ca);
		const upstreamPort = (upstream.address() as { port: number }).port;
		const runId = `bun-run-${process.pid}-https`;
		await insertSecret('BUN_HTTPS_HEADER', 'real-bun-value', ['localhost']);
		const allocated = await proxy.allocateRunProxy(runId, { teamId, agentId });
		try {
			const res = await fetchHttpsThroughProxy({
				proxyHost: '127.0.0.1',
				proxyPort: allocated.proxyPort,
				targetHost: 'localhost',
				targetPort: upstreamPort,
				path: '/echo',
				headers: { authorization: 'Bearer __HEZO_SECRET_BUN_HTTPS_HEADER__' },
				caCert: ca.cert,
			});
			expect(res.status).toBe(200);
			expect(httpsHits.at(-1)?.authorization).toBe('Bearer real-bun-value');
		} finally {
			await proxy.releaseRunProxy(runId);
			await new Promise<void>((resolve) => upstream.close(() => resolve()));
		}
	}, 30_000);

	test('handles concurrent run allocate/connect/release churn without hanging', async () => {
		const upstream = await startHttpsUpstream(ca);
		const upstreamPort = (upstream.address() as { port: number }).port;
		await insertSecret('BUN_CHURN_HEADER', 'churn-value', ['localhost']);
		try {
			const runs = await Promise.all(
				Array.from({ length: 6 }, async (_unused, i) => {
					const runId = `bun-churn-${process.pid}-${i}`;
					const allocated = await proxy.allocateRunProxy(runId, { teamId, agentId });
					return { runId, port: allocated.proxyPort };
				}),
			);
			const statuses = await Promise.all(
				runs.map((r) =>
					fetchHttpsThroughProxy({
						proxyHost: '127.0.0.1',
						proxyPort: r.port,
						targetHost: 'localhost',
						targetPort: upstreamPort,
						path: '/echo',
						headers: { authorization: 'Bearer __HEZO_SECRET_BUN_CHURN_HEADER__' },
						caCert: ca.cert,
					}).then((res) => res.status),
				),
			);
			expect(statuses).toEqual(runs.map(() => 200));
			await Promise.all(runs.map((r) => proxy.releaseRunProxy(r.runId)));
		} finally {
			await new Promise<void>((resolve) => upstream.close(() => resolve()));
		}
	}, 30_000);

	// A single run reaches multiple upstream hosts concurrently (e.g. a SaaS MCP
	// host plus a package registry). Each host gets its own internally-minted
	// leaf cert; a connection for one host must never be served the cert minted
	// for another. The MITM library spins up a separate per-host HTTPS server,
	// and concurrent first-time minting of two hosts must not cross the certs —
	// otherwise the client sees ERR_TLS_CERT_ALTNAME_INVALID against the wrong
	// SAN. Asserting on the served leaf cert is enough: the client↔proxy
	// handshake completes before any upstream connection, so no upstream is
	// needed and the hostnames need not resolve.
	test('concurrent connections to different hosts are each served that host cert', async () => {
		const hosts = Array.from({ length: 8 }, (_u, i) => `host-${i}.hezo-egress-test`);
		// Fresh run proxies so every host is first-seen concurrently, forcing the
		// per-host cert mint + listen to race within each proxy.
		for (let attempt = 0; attempt < 8; attempt++) {
			const runId = `bun-multihost-${process.pid}-${attempt}`;
			const allocated = await proxy.allocateRunProxy(runId, { teamId, agentId });
			try {
				const certs = await Promise.all(
					hosts.map((h) => servedCertThroughProxy(allocated.proxyPort, h, ca.cert)),
				);
				for (let i = 0; i < hosts.length; i++) {
					expect(certs[i]).toContain(hosts[i]);
				}
			} finally {
				await proxy.releaseRunProxy(runId);
			}
		}
	}, 30_000);

	// Regression for the cross-host cert route: the library caches a bare port
	// per hostname and never invalidates it, so when a per-host server goes away
	// its ephemeral port can be recycled by a different host's server, leaving
	// the original hostname pointing at the wrong leaf cert. The onConnect
	// reconciler must drop any entry whose backing server stopped listening so
	// the next tunnel rebuilds a correct server. Here we close a per-host server
	// outright (the worst case — its port is now free to recycle) and assert the
	// stale entry is gone after the next connect while a live host is untouched.
	test('purges a per-host entry whose server stopped listening on the next connect', async () => {
		const runId = `bun-selfheal-${process.pid}`;
		const victim = 'victim.hezo-egress-test';
		const survivor = 'survivor.hezo-egress-test';
		const allocated = await proxy.allocateRunProxy(runId, { teamId, agentId });
		try {
			await Promise.all([
				servedCertThroughProxy(allocated.proxyPort, victim, ca.cert),
				servedCertThroughProxy(allocated.proxyPort, survivor, ca.cert),
			]);
			const before = getSslServers(proxy, runId);
			const victimServer = before[victim]?.server;
			expect(victimServer?.listening).toBe(true);

			// The per-host server disappears; its port may now be recycled.
			await new Promise<void>((resolve) => victimServer?.close(() => resolve()));
			expect(victimServer?.listening).toBe(false);

			// Any subsequent CONNECT triggers the reconciler (runs on
			// setImmediate); give it a tick to drop the stale entry.
			await servedCertThroughProxy(allocated.proxyPort, survivor, ca.cert);
			await new Promise((resolve) => setTimeout(resolve, 50));

			const after = getSslServers(proxy, runId);
			expect(victim in after).toBe(false);
			expect(after[survivor]?.server?.listening).toBe(true);
		} finally {
			await proxy.releaseRunProxy(runId);
		}
	}, 30_000);
});

interface SslServerEntry {
	port?: number;
	server?: { listening: boolean; close: (cb: () => void) => void };
}

/** Reach into the proxy's per-run internal MITM server map for assertions. */
function getSslServers(p: EgressProxy, runId: string): Record<string, SslServerEntry> {
	const runs = (
		p as unknown as {
			runs: Map<string, { proxy: { sslServers?: Record<string, SslServerEntry> } }>;
		}
	).runs;
	return runs.get(runId)?.proxy.sslServers ?? {};
}

const httpsHits: Array<Record<string, string | string[] | undefined>> = [];

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

async function startHttpsUpstream(rootCa: { cert: string; key: string }): Promise<HttpsServer> {
	const { cert, key } = await mintCertFromCA(rootCa, 'localhost');
	const server = createHttpsServer({ cert, key }, (req, res) => {
		httpsHits.push(req.headers as Record<string, string | string[] | undefined>);
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ ok: true }));
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
	caCert: string;
}

async function fetchHttpsThroughProxy(
	opts: HttpsProxyFetchOpts,
): Promise<{ status: number; body: string }> {
	const tunnel = await new Promise<ReturnType<typeof netConnect>>((resolve, reject) => {
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
				tls.write(`${headerLines.join('\r\n')}\r\n\r\n`);
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

// Open a CONNECT tunnel for `targetHost`, complete the client↔proxy TLS
// handshake, and return a descriptor of the leaf cert the proxy served (CN +
// subjectAltName). A wrong per-host cert makes the handshake reject with
// ERR_TLS_CERT_ALTNAME_INVALID against `servername`, surfacing the cross-host
// mix-up. No upstream is contacted, so the target host need not resolve.
async function servedCertThroughProxy(
	proxyPort: number,
	targetHost: string,
	caCert: string,
): Promise<string> {
	const tunnel = await new Promise<ReturnType<typeof netConnect>>((resolve, reject) => {
		const sock = netConnect({ host: '127.0.0.1', port: proxyPort });
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
			sock.write(`CONNECT ${targetHost}:443 HTTP/1.1\r\nHost: ${targetHost}:443\r\n\r\n`);
		});
		sock.on('data', onData);
		sock.on('error', reject);
		sock.setTimeout(20_000, () => sock.destroy(new Error('CONNECT timed out')));
	});

	return new Promise<string>((resolve, reject) => {
		// rejectUnauthorized:false so a cross-host cert still completes the
		// handshake — the caller asserts on which cert was served rather than
		// the connection merely failing.
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
