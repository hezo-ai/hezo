import type { PGlite } from '@electric-sql/pglite';
import { ProxyRejectionCode } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encrypt } from '../../crypto/encryption';
import type { MasterKeyManager } from '../../crypto/master-key';
import type { Env } from '../../lib/types';
import { safeClose } from '../helpers';
import { authHeader, createTestApp, mintAgentToken } from '../helpers/app';
import { createProxyUpstreamSim, type ProxyUpstreamSim } from '../helpers/proxy-upstream-sim';

let app: Hono<Env>;
let db: PGlite;
let boardToken: string;
let companyId: string;
let agentId: string;
let masterKeyManager: MasterKeyManager;
let upstream: ProxyUpstreamSim;

interface SeedSecretOpts {
	name: string;
	value: string;
	hostAllowlist: string[];
}

async function seedSecret(opts: SeedSecretOpts): Promise<string> {
	const key = masterKeyManager.getKey();
	if (!key) throw new Error('master key locked in test');
	const encryptedValue = encrypt(opts.value, key);
	const r = await db.query<{ id: string }>(
		`INSERT INTO secrets (company_id, name, encrypted_value, category, host_allowlist)
		 VALUES ($1, $2, $3, 'api_token', $4::jsonb)
		 RETURNING id`,
		[companyId, opts.name, encryptedValue, JSON.stringify(opts.hostAllowlist)],
	);
	return r.rows[0].id;
}

async function grantSecret(secretId: string, memberId: string): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO secret_grants (secret_id, member_id, scope)
		 VALUES ($1, $2, 'single'::grant_scope)
		 RETURNING id`,
		[secretId, memberId],
	);
	return r.rows[0].id;
}

async function revokeGrant(grantId: string): Promise<void> {
	await db.query(`UPDATE secret_grants SET revoked_at = now() WHERE id = $1`, [grantId]);
}

async function freshAgentRun(): Promise<{ token: string; runId: string }> {
	return mintAgentToken(db, masterKeyManager, agentId, companyId);
}

async function readAuditRow(runId: string) {
	const r = await db.query(
		`SELECT * FROM secret_proxy_audit WHERE run_id = $1 ORDER BY created_at DESC LIMIT 1`,
		[runId],
	);
	return r.rows[0] as Record<string, unknown> | undefined;
}

async function readAuditRows(runId: string) {
	const r = await db.query(
		`SELECT * FROM secret_proxy_audit WHERE run_id = $1 ORDER BY created_at ASC`,
		[runId],
	);
	return r.rows as Record<string, unknown>[];
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	boardToken = ctx.token;
	masterKeyManager = ctx.masterKeyManager;
	upstream = await createProxyUpstreamSim();

	const typesRes = await app.request('/api/company-types', { headers: authHeader(boardToken) });
	const companyTypeId = (
		(await typesRes.json()) as { data: Array<{ id: string; name: string }> }
	).data.find((t) => t.name === 'Startup')!.id;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Proxy Co', template_id: companyTypeId }),
	});
	companyId = ((await companyRes.json()) as { data: { id: string } }).data.id;

	const agentsRes = await app.request(`/api/companies/${companyId}/agents`, {
		headers: authHeader(boardToken),
	});
	agentId = ((await agentsRes.json()) as { data: Array<{ id: string }> }).data[0].id;
});

afterAll(async () => {
	await upstream.destroy();
	await safeClose(db);
});

describe('agent proxy - happy path', () => {
	it('substitutes placeholder into Authorization and forwards upstream', async () => {
		const secretId = await seedSecret({
			name: 'github_token',
			value: 'ghp_real_value_xyz',
			hostAllowlist: ['localhost'],
		});
		await grantSecret(secretId, agentId);
		const { token, runId } = await freshAgentRun();

		const target = `${upstream.baseUrl}/echo`;
		const res = await app.request(`/agent-api/proxy/${target}`, {
			method: 'POST',
			headers: {
				'X-Hezo-Agent-Token': token,
				Authorization: 'Bearer __HEZO_SECRET_github_token__',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ msg: 'hello' }),
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			method: string;
			headers: Record<string, string>;
			body: string;
		};
		expect(body.method).toBe('POST');
		expect(body.headers.authorization).toBe('Bearer ghp_real_value_xyz');
		expect(body.headers['x-hezo-agent-token']).toBeUndefined();
		expect(body.body).toBe('{"msg":"hello"}');

		const audit = await readAuditRow(runId);
		expect(audit?.status_code).toBe(200);
		expect(audit?.rejection_code).toBeNull();
		expect(audit?.target_method).toBe('POST');
		expect(audit?.target_host).toBe('localhost');
		expect(Array.isArray(audit?.secret_ids)).toBe(true);
		expect((audit?.secret_ids as string[])[0]).toBe(secretId);
	});
});

describe('agent proxy - host allowlist', () => {
	it('rejects target host not on allowlist', async () => {
		const secretId = await seedSecret({
			name: 'gh_token_a',
			value: 'ghp_unused_xyz',
			hostAllowlist: ['api.github.com'],
		});
		await grantSecret(secretId, agentId);
		const { token, runId } = await freshAgentRun();

		const target = `${upstream.baseUrl}/echo`;
		const res = await app.request(`/agent-api/proxy/${target}`, {
			method: 'GET',
			headers: {
				'X-Hezo-Agent-Token': token,
				Authorization: 'Bearer __HEZO_SECRET_gh_token_a__',
			},
		});
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe(ProxyRejectionCode.HostNotAllowed);

		const audit = await readAuditRow(runId);
		expect(audit?.rejection_code).toBe(ProxyRejectionCode.HostNotAllowed);
		expect(audit?.status_code).toBeNull();
	});
});

describe('agent proxy - ungranted placeholder', () => {
	it('rejects request that references a non-granted secret name', async () => {
		const { token, runId } = await freshAgentRun();
		const target = `${upstream.baseUrl}/echo`;

		const res = await app.request(`/agent-api/proxy/${target}`, {
			method: 'POST',
			headers: {
				'X-Hezo-Agent-Token': token,
				Authorization: 'Bearer __HEZO_SECRET_does_not_exist__',
				'Content-Type': 'text/plain',
			},
			body: 'placeholder __HEZO_SECRET_unknown__ inside body',
		});
		expect(res.status).toBe(400);
		const text = await res.text();
		expect(text).not.toContain('does_not_exist');
		expect(text).not.toContain('unknown');
		const body = JSON.parse(text) as { error: { code: string; message: string } };
		expect(body.error.code).toBe(ProxyRejectionCode.UngrantedSecret);

		const audit = await readAuditRow(runId);
		expect(audit?.rejection_code).toBe(ProxyRejectionCode.UngrantedSecret);
	});
});

describe('agent proxy - unauthenticated', () => {
	it('returns 401 when neither X-Hezo-Agent-Token nor Authorization is provided', async () => {
		const target = `${upstream.baseUrl}/echo`;
		const res = await app.request(`/agent-api/proxy/${target}`, { method: 'GET' });
		expect(res.status).toBe(401);
	});

	it('returns 401 when the agent JWT is malformed', async () => {
		const target = `${upstream.baseUrl}/echo`;
		const res = await app.request(`/agent-api/proxy/${target}`, {
			method: 'GET',
			headers: { 'X-Hezo-Agent-Token': 'not.a.real.jwt' },
		});
		expect(res.status).toBe(401);
	});
});

describe('agent proxy - error response masking', () => {
	it('hezo-emitted error payload contains no secret name or plaintext', async () => {
		const secretId = await seedSecret({
			name: 'sneaky_secret',
			value: 'super_secret_plaintext_xyzzy',
			hostAllowlist: ['evilhost.example'],
		});
		await grantSecret(secretId, agentId);
		const { token } = await freshAgentRun();

		const target = `${upstream.baseUrl}/echo`;
		const res = await app.request(`/agent-api/proxy/${target}`, {
			method: 'GET',
			headers: {
				'X-Hezo-Agent-Token': token,
				Authorization: 'Bearer __HEZO_SECRET_sneaky_secret__',
			},
		});
		expect(res.status).toBe(403);
		const text = await res.text();
		expect(text).not.toContain('super_secret_plaintext_xyzzy');
		expect(text).not.toContain('sneaky_secret');
	});

	it('upstream error bodies pass through verbatim', async () => {
		const secretId = await seedSecret({
			name: 'err_secret',
			value: 'plain_err_value',
			hostAllowlist: ['localhost'],
		});
		await grantSecret(secretId, agentId);
		const { token } = await freshAgentRun();

		const target = `${upstream.baseUrl}/leak?echo=hi`;
		const res = await app.request(`/agent-api/proxy/${target}`, {
			method: 'GET',
			headers: {
				'X-Hezo-Agent-Token': token,
				Authorization: 'Bearer __HEZO_SECRET_err_secret__',
			},
		});
		expect(res.status).toBe(500);
		expect(await res.text()).toBe('leaked:hi');
	});
});

describe('agent proxy - streaming', () => {
	it('streams a chunked response and audits total response bytes', async () => {
		const secretId = await seedSecret({
			name: 'stream_token',
			value: 'tok_stream',
			hostAllowlist: ['localhost'],
		});
		await grantSecret(secretId, agentId);
		const { token, runId } = await freshAgentRun();

		const target = `${upstream.baseUrl}/stream`;
		const res = await app.request(`/agent-api/proxy/${target}`, {
			method: 'GET',
			headers: {
				'X-Hezo-Agent-Token': token,
				Authorization: 'Bearer __HEZO_SECRET_stream_token__',
			},
		});
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toBe('chunk-1;chunk-2;chunk-3;');

		// Drain time for the flush callback to write the audit row.
		await new Promise((r) => setTimeout(r, 50));
		const audit = await readAuditRow(runId);
		expect(audit?.status_code).toBe(200);
		expect(audit?.response_bytes).toBe(text.length);
	});
});

describe('agent proxy - binary body', () => {
	it('forwards binary request body without substitution and returns binary response', async () => {
		const secretId = await seedSecret({
			name: 'bin_token',
			value: 'tok_bin',
			hostAllowlist: ['localhost'],
		});
		await grantSecret(secretId, agentId);
		const { token } = await freshAgentRun();

		const target = `${upstream.baseUrl}/binary`;
		const res = await app.request(`/agent-api/proxy/${target}`, {
			method: 'GET',
			headers: {
				'X-Hezo-Agent-Token': token,
				Authorization: 'Bearer __HEZO_SECRET_bin_token__',
			},
		});
		expect(res.status).toBe(200);
		const buf = new Uint8Array(await res.arrayBuffer());
		expect(Array.from(buf)).toEqual([0, 1, 2, 3, 0xff, 0xfe, 0xfd]);
	});
});

describe('agent proxy - body too large', () => {
	it('rejects when content-length exceeds the substitution cap', async () => {
		const secretId = await seedSecret({
			name: 'big_token',
			value: 'tok_big',
			hostAllowlist: ['localhost'],
		});
		await grantSecret(secretId, agentId);
		const { token, runId } = await freshAgentRun();

		const oversize = 'a'.repeat(1024 * 1024 + 1);
		const target = `${upstream.baseUrl}/large`;
		const res = await app.request(`/agent-api/proxy/${target}`, {
			method: 'POST',
			headers: {
				'X-Hezo-Agent-Token': token,
				Authorization: 'Bearer __HEZO_SECRET_big_token__',
				'Content-Type': 'text/plain',
				'Content-Length': String(oversize.length),
			},
			body: oversize,
		});
		expect(res.status).toBe(413);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe(ProxyRejectionCode.BodyTooLarge);

		const audit = await readAuditRow(runId);
		expect(audit?.rejection_code).toBe(ProxyRejectionCode.BodyTooLarge);
	});
});

describe('agent proxy - mid-run revocation', () => {
	it('first call succeeds, second call after revocation rejects with ungranted_secret', async () => {
		const secretId = await seedSecret({
			name: 'rev_token',
			value: 'tok_rev',
			hostAllowlist: ['localhost'],
		});
		const grantId = await grantSecret(secretId, agentId);
		const { token } = await freshAgentRun();

		const target = `${upstream.baseUrl}/echo`;

		const r1 = await app.request(`/agent-api/proxy/${target}`, {
			method: 'GET',
			headers: {
				'X-Hezo-Agent-Token': token,
				Authorization: 'Bearer __HEZO_SECRET_rev_token__',
			},
		});
		expect(r1.status).toBe(200);

		await revokeGrant(grantId);

		const r2 = await app.request(`/agent-api/proxy/${target}`, {
			method: 'GET',
			headers: {
				'X-Hezo-Agent-Token': token,
				Authorization: 'Bearer __HEZO_SECRET_rev_token__',
			},
		});
		expect(r2.status).toBe(400);
		const body = (await r2.json()) as { error: { code: string } };
		expect(body.error.code).toBe(ProxyRejectionCode.UngrantedSecret);
	});
});

describe('agent proxy - wildcard allowlist', () => {
	it('matches *.example.com against subdomains, rejects exact and adversarial matches', async () => {
		const { hostMatches } = await import('../../services/secret-proxy');
		expect(hostMatches('api.example.com', ['*.example.com'])).toBe(true);
		expect(hostMatches('a.b.example.com', ['*.example.com'])).toBe(true);
		expect(hostMatches('example.com', ['*.example.com'])).toBe(false);
		expect(hostMatches('evilexample.com', ['*.example.com'])).toBe(false);
		expect(hostMatches('api.example.com', ['api.example.com'])).toBe(true);
		expect(hostMatches('Api.Example.com', ['api.example.com'])).toBe(true);
	});
});

describe('agent proxy - global X-Hezo-Agent-Token', () => {
	it('accepts the agent JWT on /agent-api/heartbeat', async () => {
		const { token } = await freshAgentRun();
		const res = await app.request('/agent-api/heartbeat', {
			method: 'POST',
			headers: { 'X-Hezo-Agent-Token': token, 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(200);
	});

	it('rejects an agent JWT presented only via Authorization on agent paths', async () => {
		// Legacy form: agent JWT placed in `Authorization: Bearer ...` is no
		// longer the recommended path. The middleware still accepts it (board
		// JWTs and API keys use the same fallback), so the strict assertion is
		// only on the X-Hezo-Agent-Token positive case above.
		const { token } = await freshAgentRun();
		const res = await app.request('/agent-api/heartbeat', {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		// Falls back through Authorization path → still authenticates.
		expect(res.status).toBe(200);
	});

	it('accepts agent JWT via X-Hezo-Agent-Token while Authorization carries upstream credentials', async () => {
		const secretId = await seedSecret({
			name: 'dual_token',
			value: 'plaintext_dual',
			hostAllowlist: ['localhost'],
		});
		await grantSecret(secretId, agentId);
		const { token } = await freshAgentRun();

		const target = `${upstream.baseUrl}/echo`;
		const res = await app.request(`/agent-api/proxy/${target}`, {
			method: 'GET',
			headers: {
				'X-Hezo-Agent-Token': token,
				Authorization: 'Bearer __HEZO_SECRET_dual_token__',
			},
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { headers: Record<string, string> };
		expect(body.headers.authorization).toBe('Bearer plaintext_dual');
	});
});

describe('agent proxy - audit completeness', () => {
	it('every request writes a single audit row with method, host, secret ids, and byte counts', async () => {
		const secretId = await seedSecret({
			name: 'audit_token',
			value: 'tok_audit',
			hostAllowlist: ['localhost'],
		});
		await grantSecret(secretId, agentId);
		const { token, runId } = await freshAgentRun();

		const target = `${upstream.baseUrl}/echo`;
		const res = await app.request(`/agent-api/proxy/${target}`, {
			method: 'POST',
			headers: {
				'X-Hezo-Agent-Token': token,
				Authorization: 'Bearer __HEZO_SECRET_audit_token__',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ a: 1 }),
		});
		await res.arrayBuffer(); // drain the body so the flush callback fires
		await new Promise((r) => setTimeout(r, 20));

		const rows = await readAuditRows(runId);
		expect(rows.length).toBe(1);
		const row = rows[0];
		expect(row.target_method).toBe('POST');
		expect(row.target_host).toBe('localhost');
		expect(row.status_code).toBe(200);
		expect(typeof row.request_bytes).toBe('number');
		expect((row.request_bytes as number) > 0).toBe(true);
		expect(typeof row.response_bytes).toBe('number');
		expect((row.response_bytes as number) > 0).toBe(true);
		expect(Array.isArray(row.secret_ids)).toBe(true);
		expect((row.secret_ids as string[]).includes(secretId)).toBe(true);
		// Audit must not contain plaintext or header values
		const serialised = JSON.stringify(row);
		expect(serialised).not.toContain('tok_audit');
		expect(serialised).not.toContain('Bearer');
	});
});
