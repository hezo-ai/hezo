import type { Db } from '../src/db/database';

// biome-ignore lint/suspicious/noExplicitAny: tests parse unpredictable JSON-RPC payloads
type Json = any;

import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	restartTestApp,
} from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string; // superuser admin
let dataDir: string;
let slugA: string;
let slugB: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	dataDir = ctx.dataDir;

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

async function registerViaRest(name: string): Promise<{ id: string; token: string }> {
	const res = await app.request('/api/api-keys/register', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ name }),
	});
	expect(res.status).toBe(201);
	const data = (await res.json()).data;
	return { id: data.id, token: data.token };
}

async function approve(id: string): Promise<Response> {
	return app.request(`/api/api-keys/${id}/approve`, {
		method: 'POST',
		headers: authHeader(token),
	});
}

async function mcp(
	key: string | null,
	method: string,
	params?: unknown,
	targetApp: Hono<Env> = app,
): Promise<Json> {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (key) headers.Authorization = `Bearer ${key}`;
	const res = await targetApp.request('/mcp', {
		method: 'POST',
		headers,
		body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
	});
	return res.json();
}

function toolPayload(body: Json): Json {
	return JSON.parse(body.result.content[0].text);
}

describe('API-key self-registration', () => {
	it('returns a one-time token and lists the pending key without secrets', async () => {
		const { id, token: keyToken } = await registerViaRest('crm-bot');
		expect(keyToken).toMatch(/^hezo_/);

		const list = await app.request('/api/api-keys', { headers: authHeader(token) });
		expect(list.status).toBe(200);
		const rows = (await list.json()).data as Json[];
		const row = rows.find((r) => r.id === id);
		expect(row).toBeTruthy();
		expect(row.status).toBe('pending');
		expect(row.prefix).toHaveLength(8);
		expect(row).not.toHaveProperty('token');
		expect(row).not.toHaveProperty('key');
		expect(row).not.toHaveProperty('key_hash');
	});

	it('requires a name', async () => {
		const res = await app.request('/api/api-keys/register', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});
});

describe('a pending key is inert', () => {
	it('grants no access but can poll its status', async () => {
		const { token: keyToken } = await registerViaRest('pending-bot');

		// Status polling works (REST + MCP) while pending.
		const statusRes = await app.request('/api/api-keys/status', {
			headers: authHeader(keyToken),
		});
		expect(statusRes.status).toBe(200);
		expect((await statusRes.json()).data.status).toBe('pending');

		const mcpStatus = await mcp(keyToken, 'tools/call', {
			name: 'connection_status',
			arguments: {},
		});
		expect(toolPayload(mcpStatus).status).toBe('pending');

		// But no real tool works...
		const listProjects = await mcp(keyToken, 'tools/call', {
			name: 'list_projects',
			arguments: {},
		});
		expect(listProjects.error).toBeDefined();
		expect(listProjects.error.message).toContain('Not connected');

		// ...and no REST route works either.
		const rest = await app.request(`/api/projects/${slugA}/tasks`, {
			headers: authHeader(keyToken),
		});
		expect(rest.status).toBe(401);
	});
});

describe('approval', () => {
	it('rejects approval from a non-superuser principal', async () => {
		const { id } = await registerViaRest('victim-bot');

		// An approved API key is admin-equivalent over MCP, but it is rejected on REST
		// outright — so it can never reach the (superuser-only) approve route.
		const { id: otherId, token: otherToken } = await registerViaRest('other-bot');
		expect((await approve(otherId)).status).toBe(200);

		const res = await app.request(`/api/api-keys/${id}/approve`, {
			method: 'POST',
			headers: authHeader(otherToken),
		});
		expect(res.status).toBe(401);
	});

	it('approving grants full instance-wide MCP access', async () => {
		const { id, token: keyToken } = await registerViaRest('admin-bot');
		expect((await approve(id)).status).toBe(200);

		// list_projects spans every project across the instance.
		const projects = (
			toolPayload(await mcp(keyToken, 'tools/call', { name: 'list_projects', arguments: {} })) as {
				items: Json[];
			}
		).items;
		const slugs = projects.map((p) => p.slug);
		expect(slugs).toContain(slugA);
		expect(slugs).toContain(slugB);

		// Can create a task in a project it was never "assigned" to.
		const created = toolPayload(
			await mcp(keyToken, 'tools/call', {
				name: 'create_task',
				arguments: { project: slugB, title: 'Filed by API key', assignee_slug: 'captain' },
			}),
		);
		expect(created).not.toHaveProperty('error');
		expect(created.identifier ?? created.id).toBeTruthy();
	});

	it('stays MCP-only after approval (rejected on REST)', async () => {
		const { id, token: keyToken } = await registerViaRest('rest-probe-bot');
		await approve(id);

		// Even approved + admin-equivalent, an API key never reaches REST.
		const rest = await app.request(`/api/projects/${slugB}/tasks`, {
			headers: authHeader(keyToken),
		});
		expect(rest.status).toBe(401);

		const manage = await app.request('/api/api-keys', { headers: authHeader(keyToken) });
		expect(manage.status).toBe(401);
	});
});

describe('revocation', () => {
	it('revokes the token immediately', async () => {
		const { id, token: keyToken } = await registerViaRest('temp-bot');
		await approve(id);
		// Sanity: works before revoke.
		expect(
			(
				toolPayload(
					await mcp(keyToken, 'tools/call', { name: 'list_projects', arguments: {} }),
				) as { items: Json[] }
			).items,
		).toBeInstanceOf(Array);

		const del = await app.request(`/api/api-keys/${id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(del.status).toBe(200);

		// Immediately rejected on the next request — no token cache.
		const after = await mcp(keyToken, 'tools/call', { name: 'list_projects', arguments: {} });
		expect(after.error.message).toContain('Not connected');

		const status = await app.request('/api/api-keys/status', {
			headers: authHeader(keyToken),
		});
		expect(status.status).toBe(404);
	});
});

describe('MCP-native onboarding', () => {
	it('exposes only the onboarding tools and lets an agent self-register', async () => {
		const list = await mcp(null, 'tools/list');
		const names = (list.result.tools as Json[]).map((t) => t.name);
		expect(names).toContain('register');
		expect(names).toContain('connection_status');
		expect(names).not.toContain('create_task');

		const registered = toolPayload(
			await mcp(null, 'tools/call', { name: 'register', arguments: { name: 'mcp-onboard' } }),
		);
		expect(registered.token).toMatch(/^hezo_/);
		expect(registered.status).toBe('pending');

		const status = toolPayload(
			await mcp(registered.token, 'tools/call', { name: 'connection_status', arguments: {} }),
		);
		expect(status.status).toBe('pending');
	});
});

describe('locked instance', () => {
	it('denies an approved key while locked', async () => {
		const { id, token: keyToken } = await registerViaRest('locked-bot');
		await approve(id);

		// A fresh manager over the same DB starts locked (no key material).
		const locked = await restartTestApp(db, dataDir);
		expect(locked.masterKeyManager.getState()).toBe('locked');

		const res = await mcp(
			keyToken,
			'tools/call',
			{ name: 'list_projects', arguments: {} },
			locked.app,
		);
		expect(res.error).toBeDefined();

		const rest = await locked.app.request(`/api/projects/${slugA}/tasks`, {
			headers: authHeader(keyToken),
		});
		expect(rest.status).toBe(401);
	});
});
