import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

// biome-ignore lint/suspicious/noExplicitAny: tests parse unpredictable JSON-RPC payloads
type Json = any;

let app: Hono<Env>;
let db: Db;
let token: string; // superuser admin
let slugA: string;
let slugB: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const teamA = (await (await createTestTeam(db, { name: 'Alpha Co' })).json()).data;
	const teamB = (await (await createTestTeam(db, { name: 'Beta Co' })).json()).data;
	slugA = (await (await createTestProject(db, teamA.id, { name: 'Alpha Project' })).json()).data
		.slug;
	slugB = (await (await createTestProject(db, teamB.id, { name: 'Beta Project' })).json()).data
		.slug;
});

afterAll(async () => {
	await safeClose(db);
});

async function mint(name: string): Promise<Json> {
	const res = await app.request('/api/api-keys', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name }),
	});
	expect(res.status).toBe(201);
	return (await res.json()).data;
}

async function mcp(key: string | null, method: string, params?: unknown): Promise<Json> {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (key) headers.Authorization = `Bearer ${key}`;
	const res = await app.request('/mcp', {
		method: 'POST',
		headers,
		body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
	});
	return res.json();
}

function toolPayload(body: Json): Json {
	return JSON.parse(body.result.content[0].text);
}

describe('API keys (admin-minted)', () => {
	it('mints an active key and returns the raw key once', async () => {
		const key = await mint('Test Key');
		expect(key.key).toMatch(/^hezo_/);
		expect(key.name).toBe('Test Key');
		expect(key.prefix).toHaveLength(8);
		expect(key.status).toBe('approved');
	});

	it('lists keys without secrets', async () => {
		await mint('Listed Key');
		const res = await app.request('/api/api-keys', { headers: authHeader(token) });
		expect(res.status).toBe(200);
		const rows = (await res.json()).data as Json[];
		expect(rows.length).toBeGreaterThanOrEqual(1);
		expect(rows[0]).not.toHaveProperty('key');
		expect(rows[0]).not.toHaveProperty('key_hash');
	});

	it('is rejected on REST but authenticates MCP with instance-wide access', async () => {
		const { key } = await mint('Auth Test Key');

		// REST is the human/browser surface — API keys are not accepted there.
		const rest = await app.request('/api/api-keys', { headers: authHeader(key) });
		expect(rest.status).toBe(401);

		// The same key reaches the MCP endpoint and spans every project (instance-wide):
		// it must name the project on a project-scoped tool.
		for (const slug of [slugA, slugB]) {
			const body = await mcp(key, 'tools/call', {
				name: 'list_tasks',
				arguments: { project: slug },
			});
			const text = body.result.content[0].text;
			expect(text).not.toContain('Access denied');
			expect(Array.isArray(JSON.parse(text))).toBe(true);
		}

		// list_projects returns every project across the instance.
		const projects = toolPayload(
			await mcp(key, 'tools/call', { name: 'list_projects', arguments: {} }),
		) as Json[];
		const slugs = projects.map((p) => p.slug);
		expect(slugs).toContain(slugA);
		expect(slugs).toContain(slugB);
	});

	it('revokes a key, removing MCP access immediately', async () => {
		const apiKey = await mint('To Revoke');
		const rawKey = apiKey.key;

		const toolNames = async (): Promise<string[]> => {
			const body = await mcp(rawKey, 'tools/list');
			return (body.result.tools as Array<{ name: string }>).map((t) => t.name);
		};
		expect(await toolNames()).toContain('list_tasks');

		const del = await app.request(`/api/api-keys/${apiKey.id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(del.status).toBe(200);

		// After revocation the token is unrecognized, so it drops to the
		// unauthenticated onboarding surface (register/connection_status only).
		expect(await toolNames()).not.toContain('list_tasks');
	});

	it('requires a name', async () => {
		const res = await app.request('/api/api-keys', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});
});
