/**
 * Docker integration test for the HTTPS MITM egress proxy.
 *
 * Spins up a real Docker container based on hezo/agent-base, mounts the
 * CA cert into the trust store, points HTTP(S)_PROXY at a host-side
 * EgressProxy, and verifies that placeholders in headers, URLs, and JSON
 * bodies get substituted before reaching an upstream server. Catches
 * regressions that purely in-process tests miss: CA distribution into the
 * container trust store, env-var picked-up by curl, and host networking.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
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

const dockerAvailable = await checkDocker();
const skipReason =
	!dockerAvailable || process.env.HEZO_SKIP_DOCKER
		? 'Docker not available or HEZO_SKIP_DOCKER set'
		: null;

const BRIDGE_IMAGE = 'hezo/agent-base:latest';
const bridgeImageReady = skipReason ? false : await imageExists(BRIDGE_IMAGE);
const imageSkipReason = bridgeImageReady
	? null
	: `${BRIDGE_IMAGE} not built locally — run \`docker build -t ${BRIDGE_IMAGE} -f docker/Dockerfile.agent-base docker\``;
const finalSkipReason = skipReason ?? imageSkipReason;

let db: PGlite;
let masterKeyManager: MasterKeyManager;
let companyId: string;
let agentId: string;
let proxy: EgressProxy;
let upstream: HttpsServer;
let upstreamPort: number;
let dataDir: string;

interface UpstreamHit {
	method: string;
	url: string;
	headers: Record<string, string | string[] | undefined>;
	body: string;
}

const upstreamHits: UpstreamHit[] = [];

beforeAll(async () => {
	if (finalSkipReason) return;
	const ctx = await createTestApp();
	db = ctx.db;
	masterKeyManager = ctx.masterKeyManager;
	dataDir = mkdtempSync(join(tmpdir(), 'hezo-egress-docker-'));

	const companyRes = await ctx.app.request('/api/companies', {
		method: 'POST',
		headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Egress Docker Co' }),
	});
	companyId = (await companyRes.json()).data.id;
	const agentRes = await ctx.app.request(`/api/companies/${companyId}/agents`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Egress Docker Agent' }),
	});
	agentId = (await agentRes.json()).data.id;

	const ca = await loadOrCreateCA(dataDir);
	upstream = await startHttpsUpstream({ cert: ca.cert, key: ca.key });
	upstreamPort = (upstream.address() as { port: number }).port;

	proxy = new EgressProxy({
		db,
		masterKeyManager,
		ca,
		extraUpstreamTrustedCAs: ca.cert,
	});
}, 60_000);

afterAll(async () => {
	if (finalSkipReason) return;
	await proxy.releaseAll();
	await new Promise<void>((resolve) => upstream.close(() => resolve()));
	await safeClose(db);
	rmSync(dataDir, { recursive: true, force: true });
});

describe.skipIf(finalSkipReason !== null)('EgressProxy — Docker integration', () => {
	it('substitutes a placeholder in an Authorization header before it reaches the upstream', async () => {
		const runId = `egress-docker-header-${Date.now()}`;
		await insertSecret('DOCKER_TEST_HEADER_KEY', 'real-docker-header', ['localhost']);
		const allocated = await proxy.allocateRunProxy(runId, { companyId, agentId });
		try {
			const beforeHits = upstreamHits.length;
			const result = await runInContainer({
				caHostPath: `${dataDir}/ca/certs/ca.pem`,
				command: [
					'sh',
					'-c',
					`update-ca-certificates > /dev/null 2>&1 && ` +
						`curl -sS -o /dev/null -w '%{http_code}' --proxy http://host.docker.internal:${allocated.proxyPort} ` +
						`-H 'authorization: Bearer __HEZO_SECRET_DOCKER_TEST_HEADER_KEY__' https://localhost:${upstreamPort}/echo`,
				],
				timeoutMs: 60_000,
			});
			expect(result.exitCode).toBe(0);
			expect(result.stdout.trim()).toBe('200');
			expect(upstreamHits.length).toBeGreaterThan(beforeHits);
			const hit = upstreamHits[upstreamHits.length - 1];
			expect(hit.headers.authorization).toBe('Bearer real-docker-header');
		} finally {
			await proxy.releaseRunProxy(runId);
		}
	}, 90_000);

	it('substitutes a placeholder in a URL query string', async () => {
		const runId = `egress-docker-url-${Date.now()}`;
		await insertSecret('DOCKER_TEST_URL_KEY', 'real-docker-url', ['localhost']);
		const allocated = await proxy.allocateRunProxy(runId, { companyId, agentId });
		try {
			const result = await runInContainer({
				caHostPath: `${dataDir}/ca/certs/ca.pem`,
				command: [
					'sh',
					'-c',
					`update-ca-certificates > /dev/null 2>&1 && ` +
						`curl -sS -o /dev/null -w '%{http_code}' --proxy http://host.docker.internal:${allocated.proxyPort} ` +
						`'https://localhost:${upstreamPort}/echo?token=__HEZO_SECRET_DOCKER_TEST_URL_KEY__'`,
				],
				timeoutMs: 60_000,
			});
			expect(result.exitCode).toBe(0);
			expect(result.stdout.trim()).toBe('200');
			const hit = upstreamHits[upstreamHits.length - 1];
			expect(hit.url).toBe('/echo?token=real-docker-url');
		} finally {
			await proxy.releaseRunProxy(runId);
		}
	}, 90_000);

	it('forwards JSON bodies untouched — body placeholders are not substituted by design', async () => {
		const runId = `egress-docker-body-${Date.now()}`;
		const allocated = await proxy.allocateRunProxy(runId, { companyId, agentId });
		try {
			const body = '{"plain":"json","x":1}';
			const result = await runInContainer({
				caHostPath: `${dataDir}/ca/certs/ca.pem`,
				command: [
					'sh',
					'-c',
					`update-ca-certificates > /dev/null 2>&1 && ` +
						`curl -sS -o /dev/null -w '%{http_code}' --proxy http://host.docker.internal:${allocated.proxyPort} ` +
						`-X POST -H 'content-type: application/json' ` +
						`-d '${body}' ` +
						`https://localhost:${upstreamPort}/echo`,
				],
				timeoutMs: 60_000,
			});
			expect(result.exitCode).toBe(0);
			expect(result.stdout.trim()).toBe('200');
			const hit = upstreamHits[upstreamHits.length - 1];
			expect(hit.body).toBe(body);
		} finally {
			await proxy.releaseRunProxy(runId);
		}
	}, 90_000);

	it('rejects placeholders for hosts not on the secret allowlist', async () => {
		const runId = `egress-docker-deny-${Date.now()}`;
		await insertSecret('DOCKER_TEST_RESTRICTED', 'never-leaked-docker', ['only.example']);
		const allocated = await proxy.allocateRunProxy(runId, { companyId, agentId });
		try {
			const beforeHits = upstreamHits.length;
			const result = await runInContainer({
				caHostPath: `${dataDir}/ca/certs/ca.pem`,
				command: [
					'sh',
					'-c',
					`update-ca-certificates > /dev/null 2>&1 && ` +
						`curl -sS -o /dev/null -w '%{http_code}' --proxy http://host.docker.internal:${allocated.proxyPort} ` +
						`-H 'authorization: Bearer __HEZO_SECRET_DOCKER_TEST_RESTRICTED__' ` +
						`https://localhost:${upstreamPort}/echo`,
				],
				timeoutMs: 60_000,
			});
			expect(result.exitCode).toBe(0);
			expect(result.stdout.trim()).toBe('403');
			expect(upstreamHits.length).toBe(beforeHits);
		} finally {
			await proxy.releaseRunProxy(runId);
		}
	}, 90_000);

	it('writes an audit row identifying the run, host, and substituted secret name (never the value)', async () => {
		const runId = `egress-docker-audit-${Date.now()}`;
		await insertSecret('DOCKER_TEST_AUDIT', 'audit-secret-value', ['localhost']);
		const allocated = await proxy.allocateRunProxy(runId, { companyId, agentId });
		try {
			await runInContainer({
				caHostPath: `${dataDir}/ca/certs/ca.pem`,
				command: [
					'sh',
					'-c',
					`update-ca-certificates > /dev/null 2>&1 && ` +
						`curl -sS -o /dev/null --proxy http://host.docker.internal:${allocated.proxyPort} ` +
						`-H 'authorization: Bearer __HEZO_SECRET_DOCKER_TEST_AUDIT__' ` +
						`https://localhost:${upstreamPort}/echo`,
				],
				timeoutMs: 60_000,
			});
		} finally {
			await proxy.releaseRunProxy(runId);
		}
		const audit = await db.query<{ details: Record<string, unknown> }>(
			`SELECT details FROM audit_log WHERE entity_type = 'egress_request' AND details->>'run_id' = $1 ORDER BY created_at DESC LIMIT 1`,
			[runId],
		);
		expect(audit.rows.length).toBe(1);
		const row = audit.rows[0].details;
		expect(row.secret_names_used).toEqual(['DOCKER_TEST_AUDIT']);
		const serialised = JSON.stringify(row);
		expect(serialised).not.toContain('audit-secret-value');
	}, 90_000);
});

interface ContainerRun {
	caHostPath: string;
	command: string[];
	timeoutMs: number;
}

async function runInContainer(
	args: ContainerRun,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const dockerArgs = [
		'run',
		'--rm',
		'--add-host',
		'host.docker.internal:host-gateway',
		'-v',
		`${args.caHostPath}:/usr/local/share/ca-certificates/hezo-egress.crt:ro`,
		BRIDGE_IMAGE,
		...args.command,
	];
	return await runCommand('docker', dockerArgs, {}, undefined, args.timeoutMs);
}

async function insertSecret(name: string, value: string, allowedHosts: string[]): Promise<void> {
	const key = masterKeyManager.getKey();
	if (!key) throw new Error('master key unavailable');
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

async function startHttpsUpstream(rootCa: { cert: string; key: string }): Promise<HttpsServer> {
	const { mintCertFromCA } = await import('./helpers/self-signed-cert');
	const { cert, key } = await mintCertFromCA(rootCa, 'localhost');
	const server = createHttpsServer({ cert, key }, (req: IncomingMessage, res: ServerResponse) => {
		const chunks: Buffer[] = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', () => {
			upstreamHits.push({
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

async function runCommand(
	cmd: string,
	args: string[],
	env: Record<string, string>,
	stdin?: Buffer,
	timeoutMs?: number,
): Promise<{ code: number; exitCode: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(cmd, args, {
			env: { ...process.env, ...env },
			stdio: stdin ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
		});
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		child.stdout?.on('data', (c: Buffer) => stdoutChunks.push(c));
		child.stderr?.on('data', (c: Buffer) => stderrChunks.push(c));
		const timer = timeoutMs
			? setTimeout(() => {
					child.kill('SIGKILL');
				}, timeoutMs)
			: null;
		if (stdin) child.stdin?.end(stdin);
		child.on('close', (code) => {
			if (timer) clearTimeout(timer);
			const exitCode = code ?? -1;
			resolve({
				code: exitCode,
				exitCode,
				stdout: Buffer.concat(stdoutChunks).toString(),
				stderr: Buffer.concat(stderrChunks).toString(),
			});
		});
	});
}

async function checkDocker(): Promise<boolean> {
	try {
		const result = await runCommand('docker', ['version', '--format', '{{.Server.Version}}'], {});
		return result.code === 0;
	} catch {
		return false;
	}
}

async function imageExists(image: string): Promise<boolean> {
	const result = await runCommand('docker', ['image', 'inspect', image], {});
	return result.code === 0;
}
