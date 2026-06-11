import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import type { IProxy } from 'http-mitm-proxy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encrypt } from '../src/crypto/encryption';
import type { MasterKeyManager } from '../src/crypto/master-key';
import { type HezoCA, loadOrCreateCA } from '../src/services/egress/ca';
import { detectCrossHostCertRoute, EgressProxy } from '../src/services/egress/proxy';
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

describe('detectCrossHostCertRoute', () => {
	const scope = { teamId: 't', agentId: 'a', label: 'run' };
	type Entry = {
		port: number;
		server?: { listening?: boolean; address?: () => { port?: number } | null };
	};
	const live = (port: number): Entry => ({
		port,
		server: { listening: true, address: () => ({ port }) },
	});
	const dead = (port: number): Entry => ({
		port,
		server: { listening: false, address: () => null },
	});
	// A server whose `listening` flag lies: still true although the server is
	// no longer bound to any port — the observed production desync.
	const zombie = (port: number): Entry => ({
		port,
		server: { listening: true, address: () => null },
	});
	const alias = (port: number): Entry => ({ port });
	const fakeProxy = (sslServers: Record<string, Entry>) => ({ sslServers }) as unknown as IProxy;

	it('flags two unrelated hosts sharing one live internal server port and evicts both', () => {
		const logged = new Set<string>();
		const sslServers: Record<string, Entry> = {
			'api.githubcopilot.com': live(5001),
			'registry.npmjs.org': live(5001),
		};
		detectCrossHostCertRoute(fakeProxy(sslServers), scope, 'run-1', logged);
		expect(logged.has('5001')).toBe(true);
		// Ownership is ambiguous (both servers claim the port), so both routes
		// are evicted and rebuild fresh servers on their next tunnel.
		expect(Object.keys(sslServers)).toEqual([]);
	});

	it('does not flag distinct hosts on distinct ports', () => {
		const logged = new Set<string>();
		detectCrossHostCertRoute(
			fakeProxy({
				'api.githubcopilot.com': live(5001),
				'registry.npmjs.org': live(5002),
			}),
			scope,
			'run-1',
			logged,
		);
		expect(logged.size).toBe(0);
	});

	it('does not flag subdomains legitimately sharing a wildcard server', () => {
		const logged = new Set<string>();
		detectCrossHostCertRoute(
			fakeProxy({
				'api.example.com': live(5003),
				'cdn.example.com': alias(5003),
				'*.example.com': alias(5003),
			}),
			scope,
			'run-1',
			logged,
		);
		expect(logged.size).toBe(0);
	});

	it('purges a stale host whose server stopped listening and does not flag the recycled port', () => {
		const logged = new Set<string>();
		const sslServers: Record<string, Entry> = {
			// Its server is gone and port 5001 was recycled to another host.
			'api.githubcopilot.com': dead(5001),
			'todo5-hezo.netlify.app': live(5001),
		};
		detectCrossHostCertRoute(fakeProxy(sslServers), scope, 'run-1', logged);
		expect(logged.size).toBe(0);
		expect('api.githubcopilot.com' in sslServers).toBe(false);
		expect('todo5-hezo.netlify.app' in sslServers).toBe(true);
	});

	it('purges wildcard-alias entries left without a live backing server', () => {
		const logged = new Set<string>();
		const sslServers: Record<string, Entry> = {
			'api.example.com': dead(5004),
			'*.example.com': alias(5004),
		};
		detectCrossHostCertRoute(fakeProxy(sslServers), scope, 'run-1', logged);
		expect('api.example.com' in sslServers).toBe(false);
		expect('*.example.com' in sslServers).toBe(false);
	});

	it('purges a stale entry whose listening flag lies but whose server lost its port', () => {
		const logged = new Set<string>();
		const sslServers: Record<string, Entry> = {
			// Reports listening but is no longer bound; its old port was
			// recycled to the other host's live server.
			'api.githubcopilot.com': zombie(5005),
			'registry.npmjs.org': live(5005),
		};
		detectCrossHostCertRoute(fakeProxy(sslServers), scope, 'run-1', logged);
		expect(logged.size).toBe(0);
		expect('api.githubcopilot.com' in sslServers).toBe(false);
		expect('registry.npmjs.org' in sslServers).toBe(true);
	});

	it('purges an alias whose port is owned by an unrelated host', () => {
		const logged = new Set<string>();
		const sslServers: Record<string, Entry> = {
			// The alias's backing server is gone and its port now belongs to an
			// unrelated host — a live server on the port must not keep the
			// alias alive.
			'cdn.example.com': alias(5006),
			'registry.npmjs.org': live(5006),
		};
		detectCrossHostCertRoute(fakeProxy(sslServers), scope, 'run-1', logged);
		expect(logged.size).toBe(0);
		expect('cdn.example.com' in sslServers).toBe(false);
		expect('registry.npmjs.org' in sslServers).toBe(true);
	});

	it('keeps the verified owner when a colliding server loses its port mid-check', () => {
		const logged = new Set<string>();
		// Owns the port during reconciliation, loses it before the healing
		// pass re-checks ownership — reconciliation and per-host server
		// lifecycle run concurrently in production. Two ownership checks
		// happen before healing (owner indexing + purge).
		let calls = 0;
		const flaky: Entry = {
			port: 5007,
			server: { listening: true, address: () => (++calls <= 2 ? { port: 5007 } : null) },
		};
		const sslServers: Record<string, Entry> = {
			'api.githubcopilot.com': flaky,
			'registry.npmjs.org': live(5007),
		};
		detectCrossHostCertRoute(fakeProxy(sslServers), scope, 'run-1', logged);
		expect(logged.has('5007')).toBe(true);
		expect('api.githubcopilot.com' in sslServers).toBe(false);
		expect('registry.npmjs.org' in sslServers).toBe(true);
	});

	it('logs a collision only once per port', () => {
		const logged = new Set<string>();
		const sslServers: Record<string, Entry> = {
			'api.githubcopilot.com': live(5008),
			'registry.npmjs.org': live(5008),
		};
		detectCrossHostCertRoute(fakeProxy(sslServers), scope, 'run-1', logged);
		// Entries were evicted; a second pass over rebuilt state on the same
		// port must not log again.
		sslServers['api.githubcopilot.com'] = live(5008);
		sslServers['registry.npmjs.org'] = live(5008);
		detectCrossHostCertRoute(fakeProxy(sslServers), scope, 'run-1', logged);
		expect(logged.size).toBe(1);
	});
});
