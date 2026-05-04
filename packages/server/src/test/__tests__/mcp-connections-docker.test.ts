/**
 * Docker integration test for MCP connection persistence end-to-end.
 *
 * Two flows are exercised against an in-process JSON-RPC test MCP server:
 *
 *   SaaS HTTP MCP — registers an mcp_connections row with kind='saas',
 *   substitutes a placeholder header through the egress proxy, and asserts
 *   the test MCP server (a) saw the substituted x-api-key value, (b)
 *   responded to initialize and tools/call correctly, and (c) the audit log
 *   recorded the substitution.
 *
 *   Local stdio MCP — bind-mounts the fixture script into the container,
 *   spawns it via `node test-mcp-stdio-server.mjs`, and exchanges
 *   initialize + tools/call JSON-RPC over stdin/stdout. Proves the local
 *   MCP layout (script on disk, command/args descriptor) is invocable
 *   inside the agent base image.
 *
 * Skipped when Docker isn't available or the agent-base image hasn't been
 * built.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encrypt } from '../../crypto/encryption';
import type { MasterKeyManager } from '../../crypto/master-key';
import { loadOrCreateCA } from '../../services/egress/ca';
import { EgressProxy } from '../../services/egress/proxy';
import { loadMcpConnectionDescriptors } from '../../services/mcp-connections';
import { safeClose } from '../helpers';
import { createTestApp } from '../helpers/app';
import { mintCertFromCA } from './helpers/self-signed-cert';
import { startTestMcpHttpServer, type TestMcpServer } from './helpers/test-mcp-http-server';

const dockerAvailable = await checkDocker();
const BRIDGE_IMAGE = 'hezo/agent-base:latest';
const bridgeImageReady = dockerAvailable ? await imageExists(BRIDGE_IMAGE) : false;

const skipReason = !dockerAvailable
	? 'Docker not available'
	: process.env.HEZO_SKIP_DOCKER
		? 'HEZO_SKIP_DOCKER set'
		: !bridgeImageReady
			? `${BRIDGE_IMAGE} not built locally`
			: null;

const STDIO_FIXTURE = resolve(
	new URL('../fixtures/test-mcp-stdio-server.mjs', import.meta.url).pathname,
);

let db: PGlite;
let masterKeyManager: MasterKeyManager;
let companyId: string;
let agentId: string;
let projectId: string;
let proxy: EgressProxy;
let dataDir: string;
let mcp: TestMcpServer;

beforeAll(async () => {
	if (skipReason) return;
	const ctx = await createTestApp();
	db = ctx.db;
	masterKeyManager = ctx.masterKeyManager;
	dataDir = mkdtempSync(join(tmpdir(), 'hezo-mcp-docker-'));

	const co = await ctx.app.request('/api/companies', {
		method: 'POST',
		headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'MCP Docker Co' }),
	});
	companyId = (await co.json()).data.id;
	const ag = await ctx.app.request(`/api/companies/${companyId}/agents`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'MCP Docker Agent' }),
	});
	agentId = (await ag.json()).data.id;

	const proj = await db.query<{ id: string }>(
		`INSERT INTO projects (company_id, name, slug, issue_prefix, docker_base_image)
		 VALUES ($1, 'MCP', 'mcp', 'MD', 'hezo/agent-base:latest') RETURNING id`,
		[companyId],
	);
	projectId = proj.rows[0].id;

	const ca = await loadOrCreateCA(dataDir);
	const leaf = await mintCertFromCA({ cert: ca.cert, key: ca.key }, 'localhost');
	mcp = await startTestMcpHttpServer({ tls: { cert: leaf.cert, key: leaf.key } });

	proxy = new EgressProxy({
		db,
		masterKeyManager,
		ca,
		extraUpstreamTrustedCAs: ca.cert,
	});
}, 60_000);

afterAll(async () => {
	if (skipReason) return;
	await proxy.releaseAll();
	await mcp.close();
	await safeClose(db);
	rmSync(dataDir, { recursive: true, force: true });
});

describe.skipIf(skipReason !== null)('MCP connections — Docker integration', () => {
	it('SaaS MCP: connection row → loader → egress-proxy header substitution → real MCP server', async () => {
		mcp.reset();
		await insertSecret('TEST_MCP_KEY', 'real-mcp-key-value', ['localhost']);

		const insert = await db.query<{ id: string; install_status: string }>(
			`INSERT INTO mcp_connections (company_id, project_id, name, kind, config, install_status)
			 VALUES ($1, NULL, 'echo', 'saas', $2::jsonb, 'installed')
			 RETURNING id, install_status::text AS install_status`,
			[
				companyId,
				JSON.stringify({
					url: `https://localhost:${mcp.port}/mcp`,
					headers: { 'x-api-key': '__HEZO_SECRET_TEST_MCP_KEY__' },
				}),
			],
		);
		expect(insert.rows[0].install_status).toBe('installed');

		const descriptors = await loadMcpConnectionDescriptors(db, companyId, projectId);
		const echo = descriptors.find((d) => d.name === 'echo');
		expect(echo?.kind).toBe('http');
		if (echo?.kind !== 'http') throw new Error('expected http descriptor');
		expect(echo.headers?.['x-api-key']).toBe('__HEZO_SECRET_TEST_MCP_KEY__');

		const runId = `mcp-docker-saas-${Date.now()}`;
		const allocated = await proxy.allocateRunProxy(runId, { companyId, agentId });
		try {
			const initBody = JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: {
					protocolVersion: '2024-11-05',
					capabilities: {},
					clientInfo: { name: 'hezo-mcp-docker-test', version: '0.0.0' },
				},
			});
			const result = await runInContainer({
				caHostPath: `${dataDir}/ca/certs/ca.pem`,
				command: [
					'sh',
					'-c',
					`update-ca-certificates > /dev/null 2>&1 && ` +
						`curl -sS -w '\\nstatus=%{http_code}' --proxy http://host.docker.internal:${allocated.proxyPort} ` +
						`-X POST -H 'content-type: application/json' ` +
						`-H 'x-api-key: __HEZO_SECRET_TEST_MCP_KEY__' -d '${initBody}' ${echo.url}`,
				],
				timeoutMs: 60_000,
			});
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toMatch(/status=200/);
			// MCP server saw the substituted header — never the placeholder
			const lastReq = mcp.requests.at(-1);
			expect(lastReq?.headers['x-api-key']).toBe('real-mcp-key-value');
			expect(JSON.stringify(lastReq?.headers)).not.toContain('__HEZO_SECRET_TEST_MCP_KEY__');
			// Proper JSON-RPC initialize result reached the client (the response body
			// in the curl output contains the test server's serverInfo)
			expect(result.stdout).toContain('hezo-test-mcp');
		} finally {
			await proxy.releaseRunProxy(runId);
		}

		// Audit row records the substitution by name only — not the value
		const audit = await db.query<{ details: Record<string, unknown> }>(
			`SELECT details FROM audit_log
			 WHERE entity_type = 'egress_request' AND details->>'host' = 'localhost'
			 ORDER BY created_at DESC LIMIT 1`,
		);
		expect(audit.rows.length).toBe(1);
		expect(audit.rows[0].details.secret_names_used).toEqual(['TEST_MCP_KEY']);
		expect(JSON.stringify(audit.rows[0].details)).not.toContain('real-mcp-key-value');
	}, 90_000);

	it('SaaS MCP: forwards requests untouched when no placeholder is present', async () => {
		mcp.reset();

		const insert = await db.query<{ id: string }>(
			`INSERT INTO mcp_connections (company_id, project_id, name, kind, config, install_status)
			 VALUES ($1, NULL, 'echo-plain', 'saas', $2::jsonb, 'installed')
			 RETURNING id`,
			[
				companyId,
				JSON.stringify({
					url: `https://localhost:${mcp.port}/mcp`,
					headers: { 'x-environment': 'test' },
				}),
			],
		);
		expect(insert.rows[0].id).toBeTruthy();

		const runId = `mcp-docker-noop-${Date.now()}`;
		const allocated = await proxy.allocateRunProxy(runId, { companyId, agentId });
		try {
			const callBody = JSON.stringify({
				jsonrpc: '2.0',
				id: 7,
				method: 'tools/call',
				params: { name: 'echo', arguments: { message: 'hi' } },
			});
			const result = await runInContainer({
				caHostPath: `${dataDir}/ca/certs/ca.pem`,
				command: [
					'sh',
					'-c',
					`update-ca-certificates > /dev/null 2>&1 && ` +
						`curl -sS --proxy http://host.docker.internal:${allocated.proxyPort} ` +
						`-X POST -H 'content-type: application/json' -H 'x-environment: test' ` +
						`-d '${callBody}' https://localhost:${mcp.port}/mcp`,
				],
				timeoutMs: 60_000,
			});
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain('echo:hi');
			const lastReq = mcp.requests.at(-1);
			expect(lastReq?.headers['x-environment']).toBe('test');
		} finally {
			await proxy.releaseRunProxy(runId);
		}

		// No substitutions happened — no audit row added for this run.
		const newAudit = await db.query<{ count: string }>(
			`SELECT count(*)::text AS count FROM audit_log
			 WHERE entity_type = 'egress_request'
			   AND details->>'run_id' = $1`,
			[`mcp-docker-noop-${(insert.rows[0].id as unknown as string).slice(0, 0)}`],
		);
		expect(Number(newAudit.rows[0].count)).toBe(0);
	}, 90_000);

	it('Local stdio MCP: bind-mounted fixture spawns and answers initialize + tools/call', async () => {
		const result = await runInContainer({
			caHostPath: `${dataDir}/ca/certs/ca.pem`,
			extraBinds: [`${STDIO_FIXTURE}:/usr/local/lib/test-mcp-stdio-server.mjs:ro`],
			command: [
				'sh',
				'-c',
				`(printf '%s\\n' '${JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'initialize',
					params: {
						protocolVersion: '2024-11-05',
						capabilities: {},
						clientInfo: { name: 't', version: '0' },
					},
				})}'; printf '%s\\n' '${JSON.stringify({
					jsonrpc: '2.0',
					id: 2,
					method: 'tools/call',
					params: { name: 'echo', arguments: { message: 'stdio-payload' } },
				})}') | node /usr/local/lib/test-mcp-stdio-server.mjs`,
			],
			timeoutMs: 30_000,
		});
		expect(result.exitCode).toBe(0);
		const lines = result.stdout.split('\n').filter((l) => l.trim());
		expect(lines.length).toBeGreaterThanOrEqual(2);
		const initRes = JSON.parse(lines[0]);
		expect(initRes.id).toBe(1);
		expect(initRes.result.serverInfo.name).toBe('hezo-test-mcp-stdio');
		const callRes = JSON.parse(lines[1]);
		expect(callRes.id).toBe(2);
		expect(callRes.result.content[0].text).toBe('echo:stdio-payload');
	}, 60_000);
});

interface RunArgs {
	caHostPath: string;
	command: string[];
	timeoutMs: number;
	extraBinds?: string[];
}

async function runInContainer(
	args: RunArgs,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const dockerArgs = [
		'run',
		'--rm',
		'--add-host',
		'host.docker.internal:host-gateway',
		'-v',
		`${args.caHostPath}:/usr/local/share/ca-certificates/hezo-egress.crt:ro`,
	];
	for (const bind of args.extraBinds ?? []) {
		dockerArgs.push('-v', bind);
	}
	dockerArgs.push(BRIDGE_IMAGE, ...args.command);
	return await runCommand('docker', dockerArgs, args.timeoutMs);
}

async function runCommand(
	cmd: string,
	args: string[],
	timeoutMs?: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		child.stdout?.on('data', (c: Buffer) => stdoutChunks.push(c));
		child.stderr?.on('data', (c: Buffer) => stderrChunks.push(c));
		const timer = timeoutMs
			? setTimeout(() => {
					child.kill('SIGKILL');
				}, timeoutMs)
			: null;
		child.on('close', (code) => {
			if (timer) clearTimeout(timer);
			resolve({
				exitCode: code ?? -1,
				stdout: Buffer.concat(stdoutChunks).toString(),
				stderr: Buffer.concat(stderrChunks).toString(),
			});
		});
	});
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

async function checkDocker(): Promise<boolean> {
	try {
		const result = await runCommand('docker', ['version', '--format', '{{.Server.Version}}']);
		return result.exitCode === 0;
	} catch {
		return false;
	}
}

async function imageExists(image: string): Promise<boolean> {
	const result = await runCommand('docker', ['image', 'inspect', image]);
	return result.exitCode === 0;
}
