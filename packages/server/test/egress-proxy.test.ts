import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encrypt } from '../src/crypto/encryption';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import { type HezoCA, loadOrCreateCA } from '../src/services/egress/ca';
import { PortAllocator } from '../src/services/egress/port-allocator';
import { EgressProxy } from '../src/services/egress/proxy';
import { invalidateSecretsVault } from '../src/services/egress/substitution';
import { safeClose } from './helpers';
import { createTestApp, createTestProject, createTestTeam } from './helpers/app';

let db: Db;
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

	const teamRes = await createTestTeam(ctx.db, { name: 'Egress Co' });
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
	// These tests exercise substitution/host-allowlist/body semantics, not caller
	// auth, so the shared proxy runs with auth disabled. The authed path (407 on a
	// missing/wrong token, and substitution succeeding *with* a token) has its own
	// describe block below, which stands up a separate auth-enabled proxy.
	proxy = new EgressProxy({ db, masterKeyManager, ca, authEnabled: false });
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

	it('forwards a body without placeholders unchanged', async () => {
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

	it('substitutes a placeholder hidden inside a base64 Basic credential', async () => {
		// The shape git produces, and the reason `applyToAuthorization` exists:
		// `https://x-access-token:__HEZO_SECRET_X__@host/repo.git` reaches the wire
		// as `Authorization: Basic eC1hY2Nlc3MtdG9rZW46X19IRVpPX1NFQ1JFVF9YX18=`.
		//
		// `egress-substitution.test.ts` already pins the decode/substitute/re-encode
		// itself, but it calls `substituteRequest` directly - so it stayed green
		// while the proxy skipped substitution entirely, because the cheap gate in
		// front of it (`headersContainProbe`) scanned the header verbatim and a
		// literal scan cannot see through base64. `applyToAuthorization` was correct
		// and unreachable. This asserts the whole request path instead, which is the
		// only place the gate and the substitution have to agree.
		const runId = `run-${Date.now()}-basic-b64`;
		await insertSecret('GIT_BASIC_TOKEN', 'real-git-token', ['127.0.0.1']);
		const allocated = await proxy.allocateRunProxy(runId, { teamId, agentId });
		try {
			const encoded = Buffer.from('x-access-token:__HEZO_SECRET_GIT_BASIC_TOKEN__').toString(
				'base64',
			);
			const res = await fetchThroughProxy({
				proxyHost: '127.0.0.1',
				proxyPort: allocated.proxyPort,
				url: `${upstreamUrl}/echo`,
				headers: { authorization: `Basic ${encoded}` },
			});
			expect(res.status).toBe(200);
			const sent = upstreamRequests.at(-1)?.headers.authorization;
			expect(sent).toBe(`Basic ${Buffer.from('x-access-token:real-git-token').toString('base64')}`);
			// The placeholder must not have survived to the upstream in either form.
			expect(sent).not.toContain(encoded);
		} finally {
			await proxy.releaseRunProxy(runId);
		}
	}, 30_000);

	it('leaves a Basic credential carrying no placeholder byte-identical', async () => {
		// The gate now decodes every Basic header it sees, so the pass-through case
		// has to be pinned at this level too: a re-encode that round-trips
		// differently would corrupt a credential the agent set deliberately.
		const runId = `run-${Date.now()}-basic-plain`;
		const allocated = await proxy.allocateRunProxy(runId, { teamId, agentId });
		try {
			const header = `Basic ${Buffer.from('user:pass').toString('base64')}`;
			const res = await fetchThroughProxy({
				proxyHost: '127.0.0.1',
				proxyPort: allocated.proxyPort,
				url: `${upstreamUrl}/echo`,
				headers: { authorization: header },
			});
			expect(res.status).toBe(200);
			expect(upstreamRequests.at(-1)?.headers.authorization).toBe(header);
		} finally {
			await proxy.releaseRunProxy(runId);
		}
	}, 30_000);

	it('substitutes a placeholder in a small JSON body when the secret opts in', async () => {
		const runId = `run-${Date.now()}-body-ok`;
		await insertSecret('UMAMI_PW_OK', 's3cr3t-pw', ['127.0.0.1'], true);
		const allocated = await proxy.allocateRunProxy(runId, { teamId, agentId });
		try {
			const body = '{"username":"admin","password":"__HEZO_SECRET_UMAMI_PW_OK__"}';
			const res = await fetchThroughProxy({
				proxyHost: '127.0.0.1',
				proxyPort: allocated.proxyPort,
				url: `${upstreamUrl}/api/auth/login`,
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body,
			});
			expect(res.status).toBe(200);
			const lastReq = upstreamRequests.at(-1);
			expect(lastReq?.body).toBe('{"username":"admin","password":"s3cr3t-pw"}');
			// Content-Length must be recomputed for the substituted body.
			expect(lastReq?.headers['content-length']).toBe(
				String(Buffer.byteLength('{"username":"admin","password":"s3cr3t-pw"}')),
			);
		} finally {
			await proxy.releaseRunProxy(runId);
		}
	}, 30_000);

	it('blocks a body placeholder for a secret without body opt-in with 403', async () => {
		const runId = `run-${Date.now()}-body-noopt`;
		await insertSecret('UMAMI_PW_NOOPT', 'never-leaked-body', ['127.0.0.1'], false);
		const allocated = await proxy.allocateRunProxy(runId, { teamId, agentId });
		try {
			const res = await fetchThroughProxy({
				proxyHost: '127.0.0.1',
				proxyPort: allocated.proxyPort,
				url: `${upstreamUrl}/api/auth/login`,
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: '{"password":"__HEZO_SECRET_UMAMI_PW_NOOPT__"}',
			});
			expect(res.status).toBe(403);
			expect(JSON.parse(res.body).error).toBe('secret_not_allowed_in_body');
			for (const req of upstreamRequests) {
				expect(req.body.includes('never-leaked-body')).toBe(false);
			}
		} finally {
			await proxy.releaseRunProxy(runId);
		}
	}, 30_000);

	it('does not substitute a body placeholder on a non-allowed host', async () => {
		const runId = `run-${Date.now()}-body-host`;
		await insertSecret('UMAMI_PW_HOST', 'never-leaked-host', ['only.example'], true);
		const allocated = await proxy.allocateRunProxy(runId, { teamId, agentId });
		try {
			const res = await fetchThroughProxy({
				proxyHost: '127.0.0.1',
				proxyPort: allocated.proxyPort,
				url: `${upstreamUrl}/api/auth/login`,
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: '{"password":"__HEZO_SECRET_UMAMI_PW_HOST__"}',
			});
			expect(res.status).toBe(403);
			expect(JSON.parse(res.body).error).toBe('secret_not_allowed_for_host');
			for (const req of upstreamRequests) {
				expect(req.body.includes('never-leaked-host')).toBe(false);
			}
		} finally {
			await proxy.releaseRunProxy(runId);
		}
	}, 30_000);

	it('does not substitute placeholders in a non-JSON body (streams it through)', async () => {
		const runId = `run-${Date.now()}-body-nonjson`;
		await insertSecret('UMAMI_PW_FORM', 's3cr3t-form', ['127.0.0.1'], true);
		const allocated = await proxy.allocateRunProxy(runId, { teamId, agentId });
		try {
			const body = 'password=__HEZO_SECRET_UMAMI_PW_FORM__';
			const res = await fetchThroughProxy({
				proxyHost: '127.0.0.1',
				proxyPort: allocated.proxyPort,
				url: `${upstreamUrl}/api/auth/login`,
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body,
			});
			expect(res.status).toBe(200);
			// Non-JSON is not eligible — the placeholder is forwarded verbatim.
			const lastReq = upstreamRequests.at(-1);
			expect(lastReq?.body).toBe(body);
		} finally {
			await proxy.releaseRunProxy(runId);
		}
	}, 30_000);

	it('does not substitute a JSON body larger than the 8KB cap', async () => {
		const runId = `run-${Date.now()}-body-large`;
		await insertSecret('UMAMI_PW_BIG', 's3cr3t-big', ['127.0.0.1'], true);
		const allocated = await proxy.allocateRunProxy(runId, { teamId, agentId });
		try {
			// Pad past 8192 bytes so the request is ineligible and streams unchanged.
			const padding = 'x'.repeat(9000);
			const body = `{"pad":"${padding}","password":"__HEZO_SECRET_UMAMI_PW_BIG__"}`;
			const res = await fetchThroughProxy({
				proxyHost: '127.0.0.1',
				proxyPort: allocated.proxyPort,
				url: `${upstreamUrl}/api/auth/login`,
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body,
			});
			expect(res.status).toBe(200);
			const lastReq = upstreamRequests.at(-1);
			expect(lastReq?.body).toBe(body);
			expect(lastReq?.body.includes('s3cr3t-big')).toBe(false);
		} finally {
			await proxy.releaseRunProxy(runId);
		}
	}, 30_000);

	it('passes plain requests through untouched', async () => {
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
			authEnabled: false,
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
	}, 30_000);
});

interface ProxyFetchOpts {
	proxyHost: string;
	proxyPort: number;
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	/** Per-run token; sent as `Proxy-Authorization: Basic base64(run:<token>)`. */
	token?: string | null;
}

function basicProxyAuth(token: string): string {
	return `Basic ${Buffer.from(`run:${token}`).toString('base64')}`;
}

async function fetchThroughProxy(opts: ProxyFetchOpts): Promise<{ status: number; body: string }> {
	const target = new URL(opts.url);
	const _path = `${target.pathname}${target.search}`;
	const headerLines = [
		`${opts.method ?? 'GET'} ${opts.url} HTTP/1.1`,
		`Host: ${target.host}`,
		'Connection: close',
		...(opts.token ? [`Proxy-Authorization: ${basicProxyAuth(opts.token)}`] : []),
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
	// Seeded by raw SQL, which bypasses the routes that invalidate the
	// decrypted-vault cache — so drop it here the way those routes do.
	invalidateSecretsVault();
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
			authEnabled: false,
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
			authEnabled: false,
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
			authEnabled: false,
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

describe('EgressProxy per-run caller auth', () => {
	let authProxy: EgressProxy;

	beforeAll(() => {
		authProxy = new EgressProxy({ db, masterKeyManager, ca });
	});
	afterAll(() => authProxy.releaseAll());

	it('mints a per-run token and rejects a plain request that omits it with 407', async () => {
		const runId = `auth-missing-${Date.now()}`;
		await insertSecret('AUTH_KEY_MISSING', 'real-value', ['127.0.0.1']);
		const allocated = await authProxy.allocateRunProxy(runId, { teamId, agentId });
		try {
			expect(allocated.token).toBeTruthy();
			const res = await fetchThroughProxy({
				proxyHost: '127.0.0.1',
				proxyPort: allocated.proxyPort,
				url: `${upstreamUrl}/echo`,
				headers: { authorization: 'Bearer __HEZO_SECRET_AUTH_KEY_MISSING__' },
				// no token
			});
			expect(res.status).toBe(407);
			expect(JSON.parse(res.body).error).toBe('proxy_auth_required');
			// The secret must never have been substituted or reached upstream.
			for (const req of upstreamRequests) {
				expect(req.headers.authorization?.toString().includes('real-value')).not.toBe(true);
			}
		} finally {
			await authProxy.releaseRunProxy(runId);
		}
	}, 30_000);

	it('rejects a plain request bearing a wrong token with 407', async () => {
		const runId = `auth-wrong-${Date.now()}`;
		const allocated = await authProxy.allocateRunProxy(runId, { teamId, agentId });
		try {
			const res = await fetchThroughProxy({
				proxyHost: '127.0.0.1',
				proxyPort: allocated.proxyPort,
				url: `${upstreamUrl}/echo`,
				token: 'deadbeefdeadbeefdeadbeefdeadbeef',
			});
			expect(res.status).toBe(407);
		} finally {
			await authProxy.releaseRunProxy(runId);
		}
	}, 30_000);

	it('substitutes normally for a plain request bearing the correct token', async () => {
		const runId = `auth-ok-${Date.now()}`;
		await insertSecret('AUTH_KEY_OK', 'authed-secret-value', ['127.0.0.1']);
		const allocated = await authProxy.allocateRunProxy(runId, { teamId, agentId });
		try {
			const res = await fetchThroughProxy({
				proxyHost: '127.0.0.1',
				proxyPort: allocated.proxyPort,
				url: `${upstreamUrl}/echo`,
				headers: { authorization: 'Bearer __HEZO_SECRET_AUTH_KEY_OK__' },
				token: allocated.token,
			});
			expect(res.status).toBe(200);
			const lastReq = upstreamRequests.at(-1);
			expect(lastReq?.headers.authorization).toBe('Bearer authed-secret-value');
			// The proxy strips Proxy-Authorization before forwarding upstream.
			expect(lastReq?.headers['proxy-authorization']).toBeUndefined();
		} finally {
			await authProxy.releaseRunProxy(runId);
		}
	}, 30_000);

	it('rejects a CONNECT tunnel that omits the token with 407', async () => {
		const runId = `auth-connect-${Date.now()}`;
		const allocated = await authProxy.allocateRunProxy(runId, { teamId, agentId });
		try {
			const statusLine = await connectStatusLine(allocated.proxyPort, 'example.com', null);
			expect(statusLine).toMatch(/^HTTP\/1\.[01] 407/);
		} finally {
			await authProxy.releaseRunProxy(runId);
		}
	}, 30_000);

	it('answers an unauthenticated CONNECT with a complete 407 that announces the close', async () => {
		// The failure this pins cost every in-container `git clone` on the HTTPS
		// transport, and no curl-driven test could see it.
		//
		// git sets libcurl's `CURLOPT_PROXYAUTH` to `CURLAUTH_ANY`, so its first
		// CONNECT deliberately carries no credentials - it reads the 407 to learn
		// the scheme, then retries. The proxy used to answer with `Content-Length:
		// 0` and nothing else, then `destroy()` the socket: the client was told the
		// connection was still reusable, sent its authenticated retry down a socket
		// that had already been torn down mid-flush, and reported `Proxy CONNECT
		// aborted`. curl's own `-x user:pass@` sends Basic on the *first* CONNECT
		// and never reaches this path at all.
		//
		// So both halves are asserted: the response arrives whole (a flushing
		// `end()`, not `destroy()`), and it says `Connection: close` so a probing
		// client reconnects rather than reusing a socket that is going away.
		const runId = `auth-connect-407-head-${Date.now()}`;
		const allocated = await authProxy.allocateRunProxy(runId, { teamId, agentId });
		try {
			const head = await connectResponseHead(allocated.proxyPort, 'example.com', null);
			expect(head).toMatch(/^HTTP\/1\.[01] 407/);
			expect(head.toLowerCase()).toContain('proxy-authenticate: basic');
			expect(head.toLowerCase()).toContain('connection: close');
			// Whole response, terminator included - a truncated one is the bug.
			expect(head.endsWith('\r\n\r\n')).toBe(true);
		} finally {
			await authProxy.releaseRunProxy(runId);
		}
	}, 30_000);

	it('accepts a CONNECT tunnel bearing the correct token', async () => {
		const runId = `auth-connect-ok-${Date.now()}`;
		const allocated = await authProxy.allocateRunProxy(runId, { teamId, agentId });
		try {
			const statusLine = await connectStatusLine(
				allocated.proxyPort,
				'example.com',
				allocated.token,
			);
			expect(statusLine).toMatch(/^HTTP\/1\.[01] 200/);
		} finally {
			await authProxy.releaseRunProxy(runId);
		}
	}, 30_000);

	it('allocates a null token and skips auth when authEnabled is false', async () => {
		const openProxy = new EgressProxy({ db, masterKeyManager, ca, authEnabled: false });
		const runId = `auth-off-${Date.now()}`;
		await insertSecret('AUTH_KEY_OFF', 'open-value', ['127.0.0.1']);
		const allocated = await openProxy.allocateRunProxy(runId, { teamId, agentId });
		try {
			expect(allocated.token).toBeNull();
			const res = await fetchThroughProxy({
				proxyHost: '127.0.0.1',
				proxyPort: allocated.proxyPort,
				url: `${upstreamUrl}/echo`,
				headers: { authorization: 'Bearer __HEZO_SECRET_AUTH_KEY_OFF__' },
				// no token — accepted because auth is off
			});
			expect(res.status).toBe(200);
			expect(upstreamRequests.at(-1)?.headers.authorization).toBe('Bearer open-value');
		} finally {
			await openProxy.releaseRunProxy(runId);
			await openProxy.releaseAll();
		}
	}, 30_000);
});

/** Send a raw CONNECT and resolve the proxy's whole response header block, so a
 * truncated or connection-management-silent answer is visible. Reads until the
 * blank line or EOF rather than taking the first chunk, since `destroy()` mid-
 * flush is precisely the failure being ruled out. */
async function connectResponseHead(
	proxyPort: number,
	targetHost: string,
	token: string | null,
): Promise<string> {
	const { connect: netConnect } = await import('node:net');
	return new Promise<string>((resolve, reject) => {
		const sock = netConnect({ host: '127.0.0.1', port: proxyPort });
		const auth = token ? `Proxy-Authorization: ${basicProxyAuth(token)}\r\n` : '';
		let buf = '';
		const done = () => {
			sock.destroy();
			resolve(buf);
		};
		sock.on('connect', () => {
			sock.write(`CONNECT ${targetHost}:443 HTTP/1.1\r\nHost: ${targetHost}:443\r\n${auth}\r\n`);
		});
		sock.on('data', (chunk: Buffer) => {
			buf += chunk.toString();
			if (buf.includes('\r\n\r\n')) done();
		});
		sock.on('end', done);
		sock.on('close', done);
		sock.on('error', reject);
		sock.setTimeout(20_000, () => sock.destroy(new Error('CONNECT head timed out')));
	});
}

/** Send a raw CONNECT (optionally with per-run creds) and resolve the proxy's
 * HTTP status line, without completing any TLS handshake. */
async function connectStatusLine(
	proxyPort: number,
	targetHost: string,
	token: string | null,
): Promise<string> {
	const { connect: netConnect } = await import('node:net');
	return new Promise<string>((resolve, reject) => {
		const sock = netConnect({ host: '127.0.0.1', port: proxyPort });
		const auth = token ? `Proxy-Authorization: ${basicProxyAuth(token)}\r\n` : '';
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
