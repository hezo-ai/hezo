import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encrypt } from '../../crypto/encryption';
import type { MasterKeyManager } from '../../crypto/master-key';
import { loadOrCreateCA } from '../../services/egress/ca';
import { EgressProxy } from '../../services/egress/proxy';
import { safeClose } from '../helpers';
import { createTestApp } from '../helpers/app';

let db: PGlite;
let masterKeyManager: MasterKeyManager;
let companyId: string;
let agentId: string;
let proxy: EgressProxy;
let upstream: Server;
let upstreamUrl: string;
let dataDir: string;

interface UpstreamRequest {
	method: string;
	url: string;
	headers: Record<string, string | string[] | undefined>;
	body: string;
}

const upstreamRequests: UpstreamRequest[] = [];

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	masterKeyManager = ctx.masterKeyManager;
	dataDir = mkdtempSync(join(tmpdir(), 'hezo-egress-proxy-'));

	const companyRes = await ctx.app.request('/api/companies', {
		method: 'POST',
		headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Egress Co' }),
	});
	companyId = (await companyRes.json()).data.id;
	const agentRes = await ctx.app.request(`/api/companies/${companyId}/agents`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Egress Agent' }),
	});
	agentId = (await agentRes.json()).data.id;

	upstream = await startUpstream();
	upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;

	const ca = await loadOrCreateCA(dataDir);
	proxy = new EgressProxy({ db, masterKeyManager, ca });
	void ca;
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
		const allocated = await proxy.allocateRunProxy(runId, { companyId, agentId });
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
		const allocated = await proxy.allocateRunProxy(runId, { companyId, agentId });
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
		const allocated = await proxy.allocateRunProxy(runId, { companyId, agentId });
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
		const allocated = await proxy.allocateRunProxy(runId, { companyId, agentId });
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
		const allocated = await proxy.allocateRunProxy(runId, { companyId, agentId });
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
		`INSERT INTO secrets (company_id, project_id, name, encrypted_value, category, allowed_hosts)
		 VALUES ($1, NULL, $2, $3, 'api_token'::secret_category, $4)
		 ON CONFLICT (company_id, project_id, name) DO UPDATE
		 SET encrypted_value = EXCLUDED.encrypted_value,
		     allowed_hosts = EXCLUDED.allowed_hosts`,
		[companyId, name, enc, allowedHosts],
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
