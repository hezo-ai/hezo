import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TLSSocket, connect as tlsConnect } from 'node:tls';
import { encrypt } from '../../src/crypto/encryption';
import type { MasterKeyManager } from '../../src/crypto/master-key';
import type { Db } from '../../src/db/database';
import { type HezoCA, loadOrCreateCA } from '../../src/services/egress/ca';
import { EgressProxy } from '../../src/services/egress/proxy';
import { createTestApp, createTestProject, createTestTeam } from '../helpers/app';
import { mintCertFromCA } from '../helpers/self-signed-cert';

// Runtime tier: this spec runs under `bun test`, exercising the egress proxy on
// the production Bun runtime rather than the Node runtime that vitest uses. It
// guards the HTTPS MITM path — Bun's https.Server lacks addContext and ignores
// SNICallback, so any single-server SNI scheme (e.g. forceSNI) silently breaks
// here even though it passes under Node/vitest.

let db: Db;
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

	const teamRes = await createTestTeam(ctx.db, { name: 'Egress Bun Co' });
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
	// These tests exercise the Bun TLS MITM path, not caller auth, so the shared
	// proxy runs with auth disabled. Authed CONNECT (407 without a token, a full
	// MITM handshake with one) is covered in its own describe block below.
	proxy = new EgressProxy({
		db,
		masterKeyManager,
		ca,
		extraUpstreamTrustedCAs: ca.cert,
		authEnabled: false,
	});
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

	// Body substitution reads the decrypted request body off the MITM TLS stream
	// and re-writes it upstream — runtime-sensitive on Bun, so guard it here.
	test('substitutes a JSON body placeholder through the MITM path and recomputes Content-Length', async () => {
		const upstream = await startHttpsBodyUpstream(ca);
		const upstreamPort = (upstream.address() as { port: number }).port;
		const runId = `bun-run-${process.pid}-body`;
		await insertSecret('BUN_BODY_PW', 'real-bun-pw', ['localhost'], true);
		const allocated = await proxy.allocateRunProxy(runId, { teamId, agentId });
		try {
			const res = await fetchHttpsThroughProxy({
				proxyHost: '127.0.0.1',
				proxyPort: allocated.proxyPort,
				targetHost: 'localhost',
				targetPort: upstreamPort,
				path: '/api/auth/login',
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: '{"username":"admin","password":"__HEZO_SECRET_BUN_BODY_PW__"}',
				caCert: ca.cert,
			});
			expect(res.status).toBe(200);
			const hit = httpsBodyHits.at(-1);
			expect(hit?.body).toBe('{"username":"admin","password":"real-bun-pw"}');
			expect(hit?.headers['content-length']).toBe(
				String(Buffer.byteLength('{"username":"admin","password":"real-bun-pw"}')),
			);
		} finally {
			await proxy.releaseRunProxy(runId);
			await new Promise<void>((resolve) => upstream.close(() => resolve()));
		}
	}, 30_000);

	// A proxy must not relay hop-by-hop headers (RFC 7230 §6.1) to the upstream.
	// Relaying the client's `connection: keep-alive` / `keep-alive` / `upgrade`
	// lets the client dictate the upstream socket's lifetime against the proxy's
	// own connection management — a contributor to upstream sockets lingering past
	// the run. Normal end-to-end headers (and secret substitution) still pass.
	test('does not relay hop-by-hop headers to the upstream', async () => {
		const upstream = await startHttpsUpstream(ca);
		const upstreamPort = (upstream.address() as { port: number }).port;
		const runId = `bun-run-${process.pid}-hopbyhop`;
		await insertSecret('BUN_HOPBYHOP', 'real-value', ['localhost']);
		const allocated = await proxy.allocateRunProxy(runId, { teamId, agentId });
		try {
			const res = await fetchHttpsThroughProxy({
				proxyHost: '127.0.0.1',
				proxyPort: allocated.proxyPort,
				targetHost: 'localhost',
				targetPort: upstreamPort,
				path: '/echo',
				headers: {
					authorization: 'Bearer __HEZO_SECRET_BUN_HOPBYHOP__',
					'keep-alive': 'timeout=5, max=1000',
				},
				caCert: ca.cert,
			});
			expect(res.status).toBe(200);
			const received = httpsHits.at(-1) ?? {};
			// The client's hop-by-hop `keep-alive` header must not reach the upstream
			// (the proxy's own client never adds this header, so its presence would
			// mean the client's copy was relayed).
			expect(received['keep-alive']).toBeUndefined();
			// End-to-end headers still pass, and the secret is still substituted.
			expect(received.authorization).toBe('Bearer real-value');
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
	// SAN. Full verification is on (`strictHandshakeThroughProxy`) so a crossed
	// cert *rejects the handshake* exactly as curl does, rather than completing
	// and being papered over by a CN that mockttp always sets to the host. The
	// set mixes 3-label hosts with a 2-label apex (`bun.sh`, the production
	// incident) so apex minting is covered too. The handshake completes before
	// any upstream connection, so no upstream is needed and the hosts need not
	// resolve.
	test('concurrent connections to different hosts each pass strict verification', async () => {
		const hosts = ['bun.sh', ...Array.from({ length: 7 }, (_u, i) => `host-${i}.hezo-egress-test`)];
		// Fresh run proxies so every host is first-seen concurrently, forcing the
		// per-host cert mint + listen to race within each proxy.
		for (let attempt = 0; attempt < 8; attempt++) {
			const runId = `bun-multihost-${process.pid}-${attempt}`;
			const allocated = await proxy.allocateRunProxy(runId, { teamId, agentId });
			try {
				const sans = await Promise.all(
					hosts.map((h) => strictHandshakeThroughProxy(allocated.proxyPort, h, ca.cert)),
				);
				for (let i = 0; i < hosts.length; i++) {
					expect(sans[i]).toContain(hosts[i]);
				}
			} finally {
				await proxy.releaseRunProxy(runId);
			}
		}
	}, 30_000);

	// Regression for the production incident (run engineer/TO-3): a per-host
	// internal server died mid-run while its hostname was still routed to it, so
	// every later CONNECT for that host dialed a dead loopback port
	// (ECONNREFUSED) for the rest of the run. The hostname must route to a *live*
	// server: a dead one is rebuilt on the next tunnel, never dialed.
	test('rebuilds a per-host server that died mid-run instead of dialing a dead port', async () => {
		const runId = `bun-rebuild-${process.pid}`;
		const host = 'registry.npmjs.org';
		const allocated = await proxy.allocateRunProxy(runId, { teamId, agentId });
		try {
			const first = await strictHandshakeThroughProxy(allocated.proxyPort, host, ca.cert);
			expect(first).toContain(host);

			const before = getHostServers(proxy, runId);
			const rec = before.get(host);
			if (!rec) throw new Error('per-host server missing');
			expect(rec.server.listening).toBe(true);

			// The per-host server dies; its loopback port is now refused. A later
			// CONNECT must rebuild and still pass strict verification — never dial
			// a dead/recycled port and serve another host's cert.
			await new Promise<void>((resolve) => rec.server.close(() => resolve()));
			expect(rec.server.listening).toBe(false);

			// The next tunnel must rebuild a fresh live server, not ECONNREFUSED.
			const second = await strictHandshakeThroughProxy(allocated.proxyPort, host, ca.cert);
			expect(second).toContain(host);

			const after = getHostServers(proxy, runId);
			expect(after.get(host)?.server.listening).toBe(true);
			expect(after.get(host)).not.toBe(rec);
		} finally {
			await proxy.releaseRunProxy(runId);
		}
	}, 30_000);

	// Reproduces the production collapse (run engineer/TO-6 cert-altname): a
	// long-lived TLS connection to host A stayed open (the GitHub MCP SSE channel)
	// while npm/curl first-touched other hosts. Under Bun, `server.listen(0)` +
	// `server.address().port` handed every per-host server the SAME port, so the
	// later hosts collapsed onto A's server and were served A's leaf cert —
	// `ERR_TLS_CERT_ALTNAME_INVALID` / "no alternative certificate subject name".
	// The existing multi-host test (above) closes each tunnel before the next host
	// is built and never inspects ports, so it can't observe the collapse. This
	// holds A open across the builds and asserts each host gets its own SAN AND a
	// distinct recorded port (explicit allocation guarantees distinctness by
	// construction; this also locks against any revert to `listen(0)`/`address()`).
	test('builds distinct per-host servers while a long-lived connection is held open', async () => {
		const runId = `bun-heldopen-${process.pid}`;
		const hostA = 'held-open.hezo-egress-test';
		const laterHosts = [
			'bun.sh',
			...Array.from({ length: 6 }, (_u, i) => `later-${i}.hezo-egress-test`),
		];
		const allocated = await proxy.allocateRunProxy(runId, { teamId, agentId });
		let heldTls: TLSSocket | undefined;
		try {
			// 1. Open and KEEP OPEN a strict-verified TLS connection to host A.
			const heldTunnel = await openConnectTunnel(allocated.proxyPort, hostA);
			const heldSan = await new Promise<string>((resolve, reject) => {
				heldTls = tlsConnect(
					{ socket: heldTunnel, servername: hostA, ca: [ca.cert], rejectUnauthorized: true },
					() => resolve(heldTls?.getPeerCertificate().subjectaltname ?? ''),
				);
				heldTls.on('error', reject);
				heldTls.setTimeout(20_000, () => heldTls?.destroy(new Error('held handshake timed out')));
			});
			expect(heldSan).toContain(hostA);

			// 2. While A is still open, first-touch B..N. Each must pass strict
			//    verification (rejectUnauthorized) with its OWN SAN, never A's.
			const sans = await Promise.all(
				laterHosts.map((h) => strictHandshakeThroughProxy(allocated.proxyPort, h, ca.cert)),
			);
			for (let i = 0; i < laterHosts.length; i++) {
				expect(sans[i]).toContain(laterHosts[i]);
			}

			// 3. Every recorded per-host port is distinct — the direct collapse signal.
			const map = getHostServers(proxy, runId);
			const ports = [hostA, ...laterHosts]
				.map((h) => map.get(h)?.port)
				.filter((p): p is number => p != null);
			expect(ports.length).toBe(laterHosts.length + 1);
			expect(new Set(ports).size).toBe(ports.length);
		} finally {
			heldTls?.destroy();
			await proxy.releaseRunProxy(runId);
		}
	}, 30_000);

	// Upstream connection policy: each run owns a keep-alive-OFF agent rather than
	// sharing the process-global pool. Keep-alive off means no upstream socket is
	// parked idle in a pool to outlive the run (idle pooled sockets can't be
	// reliably closed under Bun), and per-run ownership keeps one run's upstream
	// connections from being shared with another's. Asserted at the config level —
	// deterministic, unlike socket-close timing under Bun.
	test('gives each run its own keep-alive-off upstream agent', async () => {
		const idA = `bun-agent-a-${process.pid}`;
		const idB = `bun-agent-b-${process.pid}`;
		const a = await proxy.allocateRunProxy(idA, { teamId, agentId });
		const b = await proxy.allocateRunProxy(idB, { teamId, agentId });
		try {
			const runs = (
				proxy as unknown as {
					runs: Map<
						string,
						{ upstreamAgent: { keepAlive?: boolean; options?: { keepAlive?: boolean } } }
					>;
				}
			).runs;
			const agentA = runs.get(idA)?.upstreamAgent;
			const agentB = runs.get(idB)?.upstreamAgent;
			if (!agentA || !agentB) throw new Error('per-run upstream agent missing');
			// Per-run isolation — not one shared/global agent.
			expect(agentA).not.toBe(agentB);
			// Keep-alive disabled (Node exposes it as `keepAlive`; the options bag
			// carries what was passed) so upstream sockets are never pooled idle.
			const keepAlive = agentA.keepAlive ?? agentA.options?.keepAlive;
			expect(keepAlive).toBe(false);
		} finally {
			await proxy.releaseRunProxy(idA);
			await proxy.releaseRunProxy(idB);
		}
		expect(a.proxyPort).not.toBe(b.proxyPort);
	}, 30_000);
});

describe('EgressProxy per-run CONNECT auth under Bun', () => {
	let authProxy: EgressProxy;

	beforeAll(() => {
		authProxy = new EgressProxy({
			db,
			masterKeyManager,
			ca,
			extraUpstreamTrustedCAs: ca.cert,
		});
	});
	afterAll(() => authProxy.releaseAll());

	test('rejects a CONNECT that omits the per-run token with 407', async () => {
		const runId = `bun-auth-407-${teamId}`;
		const allocated = await authProxy.allocateRunProxy(runId, { teamId, agentId });
		try {
			expect(allocated.token).toBeTruthy();
			const statusLine = await connectStatusLine(allocated.proxyPort, 'hostx.egress-test', null);
			expect(statusLine).toMatch(/^HTTP\/1\.[01] 407/);
		} finally {
			await authProxy.releaseRunProxy(runId);
		}
	}, 30_000);

	test('completes the MITM handshake for a CONNECT bearing the correct token', async () => {
		const runId = `bun-auth-ok-${teamId}`;
		const allocated = await authProxy.allocateRunProxy(runId, { teamId, agentId });
		try {
			const host = 'hostx.egress-test';
			const san = await strictHandshakeThroughProxy(
				allocated.proxyPort,
				host,
				ca.cert,
				allocated.token,
			);
			expect(san).toContain(host);
		} finally {
			await authProxy.releaseRunProxy(runId);
		}
	}, 30_000);
});

/** Reach into the proxy's per-run internal per-host server map for assertions. */
function getHostServers(
	p: EgressProxy,
	runId: string,
): Map<string, { server: HttpsServer; port: number }> {
	const runs = (
		p as unknown as {
			runs: Map<string, { hostServers: Map<string, { server: HttpsServer; port: number }> }>;
		}
	).runs;
	return runs.get(runId)?.hostServers ?? new Map();
}

const httpsHits: Array<Record<string, string | string[] | undefined>> = [];

async function insertSecret(
	name: string,
	value: string,
	allowedHosts: string[],
	allowBodySubstitution = false,
): Promise<void> {
	const key = masterKeyManager.getKey();
	if (!key) throw new Error('master key unavailable in test');
	const enc = encrypt(value, key);
	await db.query(
		`INSERT INTO secrets (name, encrypted_value, category, allowed_hosts, allow_body_substitution)
		 VALUES ($1, $2, 'api_token'::secret_category, $3, $4)
		 ON CONFLICT (name) DO UPDATE
		 SET encrypted_value = EXCLUDED.encrypted_value,
		     allowed_hosts = EXCLUDED.allowed_hosts,
		     allow_body_substitution = EXCLUDED.allow_body_substitution`,
		[name, enc, allowedHosts, allowBodySubstitution],
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

const httpsBodyHits: Array<{ headers: Record<string, string | undefined>; body: string }> = [];

/** HTTPS upstream that records the decrypted request body — used to assert body
 * substitution survives the MITM read-and-rewrite path on the Bun runtime. */
async function startHttpsBodyUpstream(rootCa: { cert: string; key: string }): Promise<HttpsServer> {
	const { cert, key } = await mintCertFromCA(rootCa, 'localhost');
	const server = createHttpsServer({ cert, key }, (req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk) => chunks.push(chunk));
		req.on('end', () => {
			httpsBodyHits.push({
				headers: req.headers as Record<string, string | undefined>,
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

// Complete a CONNECT + client↔proxy TLS handshake with full verification on
// (`rejectUnauthorized:true`, `servername:targetHost`), exactly as curl does.
// A leaf whose SAN doesn't cover `targetHost` rejects with
// ERR_TLS_CERT_ALTNAME_INVALID — the production symptom (`curl: (60) SSL: no
// alternative certificate subject name matches target host name`). Resolves
// with the verified SAN.
async function strictHandshakeThroughProxy(
	proxyPort: number,
	targetHost: string,
	caCert: string,
	token?: string | null,
): Promise<string> {
	const tunnel = await openConnectTunnel(proxyPort, targetHost, token);
	return new Promise<string>((resolve, reject) => {
		const tls = tlsConnect(
			{ socket: tunnel, servername: targetHost, ca: [caCert], rejectUnauthorized: true },
			() => {
				const san = tls.getPeerCertificate().subjectaltname ?? '';
				tls.end();
				resolve(san);
			},
		);
		tls.on('error', reject);
		tls.setTimeout(20_000, () => tls.destroy(new Error('tls handshake timed out')));
	});
}

async function openConnectTunnel(
	proxyPort: number,
	targetHost: string,
	token?: string | null,
): Promise<ReturnType<typeof netConnect>> {
	return new Promise<ReturnType<typeof netConnect>>((resolve, reject) => {
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
		const auth = token
			? `Proxy-Authorization: Basic ${Buffer.from(`run:${token}`).toString('base64')}\r\n`
			: '';
		sock.on('connect', () => {
			sock.write(`CONNECT ${targetHost}:443 HTTP/1.1\r\nHost: ${targetHost}:443\r\n${auth}\r\n`);
		});
		sock.on('data', onData);
		sock.on('error', reject);
		sock.setTimeout(20_000, () => sock.destroy(new Error('CONNECT timed out')));
	});
}

/** Raw CONNECT that resolves the proxy's HTTP status line (no TLS), for the
 * 407 path. */
async function connectStatusLine(
	proxyPort: number,
	targetHost: string,
	token: string | null,
): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const sock = netConnect({ host: '127.0.0.1', port: proxyPort });
		const auth = token
			? `Proxy-Authorization: Basic ${Buffer.from(`run:${token}`).toString('base64')}\r\n`
			: '';
		sock.on('connect', () => {
			sock.write(`CONNECT ${targetHost}:443 HTTP/1.1\r\nHost: ${targetHost}:443\r\n${auth}\r\n`);
		});
		sock.once('data', (chunk: Buffer) => {
			const statusLine = chunk.toString().split('\r\n')[0] ?? '';
			sock.destroy();
			resolve(statusLine);
		});
		sock.on('error', reject);
		sock.setTimeout(20_000, () => sock.destroy(new Error('CONNECT status timed out')));
	});
}
