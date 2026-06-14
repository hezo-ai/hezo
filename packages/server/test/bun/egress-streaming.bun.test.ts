import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { connect as netConnect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TLSSocket, connect as tlsConnect } from 'node:tls';
import type { PGlite } from '@electric-sql/pglite';
import { encrypt } from '../../src/crypto/encryption';
import type { MasterKeyManager } from '../../src/crypto/master-key';
import { type HezoCA, loadOrCreateCA } from '../../src/services/egress/ca';
import { EgressProxy } from '../../src/services/egress/proxy';
import { createTestApp, createTestProject } from '../helpers/app';
import { mintCertFromCA } from '../helpers/self-signed-cert';

// Runtime tier: runs under `bun test` on the production Bun runtime. It guards
// the egress proxy's handling of long-lived Streamable-HTTP (SSE) responses —
// the transport every remote MCP server (e.g. api.githubcopilot.com) uses.
// Bun's https.Server `closeAllConnections()` does not reach a hijacked CONNECT
// socket or an in-flight streamed response, so an open SSE channel parked
// `server.close()` until the 5s deadline and leaked the upstream connection on
// every run that touched the GitHub MCP. Node/vitest never sees this — the
// failure is specific to Bun's connection accounting.

let db: PGlite;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let agentId: string;
let ca: HezoCA;
let dataDir: string;
let proxy: EgressProxy;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	masterKeyManager = ctx.masterKeyManager;
	dataDir = mkdtempSync(join(tmpdir(), 'hezo-egress-stream-'));

	const teamRes = await ctx.app.request('/api/teams', {
		method: 'POST',
		headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Egress Stream Co' }),
	});
	teamId = (await teamRes.json()).data.id;
	const projectSlug = (
		await (await createTestProject(db, teamId, { name: 'Stream Project' })).json()
	).data.slug;
	const agentRes = await ctx.app.request(`/api/projects/${projectSlug}/agents`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Egress Stream Agent' }),
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

async function insertSecret(name: string, value: string, allowedHosts: string[]): Promise<void> {
	const key = masterKeyManager.getKey();
	if (!key) throw new Error('master key unavailable in test');
	await db.query(
		`INSERT INTO secrets (name, encrypted_value, category, allowed_hosts)
		 VALUES ($1, $2, 'api_token'::secret_category, $3)
		 ON CONFLICT (name) DO UPDATE
		 SET encrypted_value = EXCLUDED.encrypted_value, allowed_hosts = EXCLUDED.allowed_hosts`,
		[name, encrypt(value, key), allowedHosts],
	);
}

/** Open a CONNECT tunnel through the proxy and complete the TLS handshake to the
 * minted per-host cert, returning the decrypted TLS socket ready for a request. */
async function tunnelTo(proxyPort: number, host: string, port: number): Promise<TLSSocket> {
	const sock = await new Promise<Socket>((resolve, reject) => {
		const s = netConnect({ host: '127.0.0.1', port: proxyPort });
		const onData = (chunk: Buffer) => {
			s.removeListener('data', onData);
			if (/^HTTP\/1\.[01] 200/.test(chunk.toString().split('\r\n')[0] ?? '')) resolve(s);
			else reject(new Error(`CONNECT failed: ${chunk.toString().split('\r\n')[0]}`));
		};
		s.on('connect', () =>
			s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`),
		);
		s.on('data', onData);
		s.on('error', reject);
		s.setTimeout(15_000, () => s.destroy(new Error('CONNECT timed out')));
	});
	return await new Promise<TLSSocket>((resolve, reject) => {
		const tls = tlsConnect({ socket: sock, servername: host, ca: [ca.cert] }, () => resolve(tls));
		tls.on('error', reject);
	});
}

describe('EgressProxy streaming + teardown under Bun', () => {
	// An SSE response must reach the client chunk-by-chunk as the upstream writes
	// it — a Streamable-HTTP MCP transport breaks if the server→client channel is
	// buffered until the response ends (which, for a long-lived stream, is never).
	test('forwards an SSE response incrementally, not buffered until end', async () => {
		const { cert, key } = await mintCertFromCA(ca, 'localhost');
		const upstream: HttpsServer = createHttpsServer({ cert, key }, (_req, res) => {
			res.writeHead(200, { 'content-type': 'text/event-stream' });
			res.write('data: first\n\n');
			// Second event lands well after the first; if the proxy buffered, the
			// client would see nothing until both are written + the stream ends.
			setTimeout(() => res.end('data: second\n\n'), 600);
		});
		await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
		const upstreamPort = (upstream.address() as { port: number }).port;
		await insertSecret('STREAM_INCR', 'tok', ['localhost']);
		const runId = `stream-incr-${process.pid}`;
		const allocated = await proxy.allocateRunProxy(runId, { teamId, agentId });

		try {
			const tls = await tunnelTo(allocated.proxyPort, 'localhost', upstreamPort);
			let acc = '';
			const sawFirstAlone = new Promise<boolean>((resolve) => {
				tls.on('data', (c: Buffer) => {
					acc += c.toString();
					if (acc.includes('first') && !acc.includes('second')) resolve(true);
				});
				tls.setTimeout(5_000, () => resolve(false));
			});
			tls.write(
				`GET /sse HTTP/1.1\r\nHost: localhost:${upstreamPort}\r\nAccept: text/event-stream\r\n` +
					`Authorization: Bearer __HEZO_SECRET_STREAM_INCR__\r\n\r\n`,
			);

			// There must be a moment where 'first' has arrived but 'second' has not
			// — proof the bytes were flushed live rather than coalesced at end.
			expect(await sawFirstAlone).toBe(true);
			tls.destroy();
		} finally {
			await proxy.releaseRunProxy(runId);
			await new Promise<void>((r) => upstream.close(() => r()));
		}
	}, 30_000);

	// Releasing a run while a long-lived SSE stream is open must sever it promptly
	// and free the upstream connection — not park teardown on the close deadline
	// and leak the proxy→upstream socket (the production failure mode against
	// api.githubcopilot.com: "server close timed out after 5000ms").
	test('severs an open long-lived stream on release without hitting the close deadline', async () => {
		const { cert, key } = await mintCertFromCA(ca, 'localhost');
		let upstreamConnClosed = false;
		const upstream: HttpsServer = createHttpsServer({ cert, key }, (req, res) => {
			res.writeHead(200, { 'content-type': 'text/event-stream' });
			res.write(': open\n\n');
			const timer = setInterval(() => res.write(': ping\n\n'), 100);
			req.on('close', () => {
				clearInterval(timer);
				upstreamConnClosed = true;
			});
		});
		await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
		const upstreamPort = (upstream.address() as { port: number }).port;
		await insertSecret('STREAM_LL', 'tok', ['localhost']);
		const runId = `stream-ll-${process.pid}`;
		const allocated = await proxy.allocateRunProxy(runId, { teamId, agentId });

		const tls = await tunnelTo(allocated.proxyPort, 'localhost', upstreamPort);
		await new Promise<void>((resolve, reject) => {
			tls.once('data', () => resolve());
			tls.once('error', reject);
			tls.setTimeout(10_000, () => reject(new Error('no SSE data')));
			tls.write(
				`GET /sse HTTP/1.1\r\nHost: localhost:${upstreamPort}\r\nAccept: text/event-stream\r\n` +
					`Authorization: Bearer __HEZO_SECRET_STREAM_LL__\r\n\r\n`,
			);
		});

		try {
			const started = Date.now();
			await proxy.releaseRunProxy(runId);
			const elapsed = Date.now() - started;
			// Well under the 5_000ms close deadline — the stream is severed, not waited on.
			expect(elapsed).toBeLessThan(2_000);

			// The upstream connection is actually torn down (no leak). Give the
			// FIN/RST a moment to land on the upstream server.
			await new Promise<void>((r) => setTimeout(r, 250));
			expect(upstreamConnClosed).toBe(true);
		} finally {
			tls.destroy();
			await new Promise<void>((r) => upstream.close(() => r()));
		}
	}, 30_000);
});
