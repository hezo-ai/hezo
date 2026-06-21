import type { PGlite } from '@electric-sql/pglite';

// biome-ignore lint/suspicious/noExplicitAny: tests parse unpredictable JSON-RPC payloads
type Json = any;

import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
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
let db: PGlite;
let token: string; // superuser admin
let masterKeyManager: MasterKeyManager;
let dataDir: string;
let slugA: string;
let slugB: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;
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
	const res = await app.request('/api/agent-connections/register', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ name }),
	});
	expect(res.status).toBe(201);
	const data = (await res.json()).data;
	return { id: data.id, token: data.token };
}

async function approve(id: string): Promise<Response> {
	return app.request(`/api/agent-connections/${id}/approve`, {
		method: 'POST',
		headers: authHeader(token),
	});
}

async function mcp(
	agentToken: string | null,
	method: string,
	params?: unknown,
	targetApp: Hono<Env> = app,
): Promise<Json> {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (agentToken) headers.Authorization = `Bearer ${agentToken}`;
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

describe('connected-agent registration', () => {
	it('returns a one-time hezoc_ token and lists without secrets', async () => {
		const { id, token: agentToken } = await registerViaRest('crm-bot');
		expect(agentToken).toMatch(/^hezoc_/);

		const list = await app.request('/api/agent-connections', { headers: authHeader(token) });
		expect(list.status).toBe(200);
		const rows = (await list.json()).data as Json[];
		const row = rows.find((r) => r.id === id);
		expect(row).toBeTruthy();
		expect(row.status).toBe('pending');
		expect(row.prefix).toHaveLength(8);
		expect(row).not.toHaveProperty('token');
		expect(row).not.toHaveProperty('token_hash');
	});

	it('requires a name', async () => {
		const res = await app.request('/api/agent-connections/register', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});
});

describe('a pending token is inert', () => {
	it('grants no access but can poll its status', async () => {
		const { token: agentToken } = await registerViaRest('pending-bot');

		// Status polling works (REST + MCP) while pending.
		const statusRes = await app.request('/api/agent-connections/status', {
			headers: authHeader(agentToken),
		});
		expect(statusRes.status).toBe(200);
		expect((await statusRes.json()).data.status).toBe('pending');

		const mcpStatus = await mcp(agentToken, 'tools/call', {
			name: 'connection_status',
			arguments: {},
		});
		expect(toolPayload(mcpStatus).status).toBe('pending');

		// But no real tool works...
		const listProjects = await mcp(agentToken, 'tools/call', {
			name: 'list_projects',
			arguments: {},
		});
		expect(listProjects.error).toBeDefined();
		expect(listProjects.error.message).toContain('Not connected');

		// ...and no REST route works either.
		const rest = await app.request(`/api/projects/${slugA}/tasks`, {
			headers: authHeader(agentToken),
		});
		expect(rest.status).toBe(401);
	});
});

describe('approval', () => {
	it('rejects approval from a non-superuser principal', async () => {
		const { id } = await registerViaRest('victim-bot');

		// An approved connected agent is admin-equivalent but explicitly may NOT
		// manage connected agents — that stays human-superuser-only. (A team-scoped
		// API key doesn't apply here: API keys are rejected on REST outright.)
		const { id: otherId, token: otherToken } = await registerViaRest('other-bot');
		expect((await approve(otherId)).status).toBe(200);

		const res = await app.request(`/api/agent-connections/${id}/approve`, {
			method: 'POST',
			headers: authHeader(otherToken),
		});
		expect(res.status).toBe(403);
	});

	it('approving grants full instance-wide access', async () => {
		const { id, token: agentToken } = await registerViaRest('admin-bot');
		expect((await approve(id)).status).toBe(200);

		// list_projects spans every project across the instance.
		const projects = toolPayload(
			await mcp(agentToken, 'tools/call', { name: 'list_projects', arguments: {} }),
		) as Json[];
		const slugs = projects.map((p) => p.slug);
		expect(slugs).toContain(slugA);
		expect(slugs).toContain(slugB);

		// Can create a task in a project it was never "assigned" to.
		const created = toolPayload(
			await mcp(agentToken, 'tools/call', {
				name: 'create_task',
				arguments: { project: slugB, title: 'Filed by connected agent', assignee_slug: 'captain' },
			}),
		);
		expect(created).not.toHaveProperty('error');
		expect(created.identifier ?? created.id).toBeTruthy();

		// REST works across any team too.
		const rest = await app.request(`/api/projects/${slugB}/tasks`, {
			headers: authHeader(agentToken),
		});
		expect(rest.status).toBe(200);
	});

	it('is admin-equivalent for instance settings but cannot manage agents', async () => {
		const { id, token: agentToken } = await registerViaRest('powerful-bot');
		await approve(id);

		// Instance admin route (credentials list) — allowed.
		const creds = await app.request('/api/credentials', { headers: authHeader(agentToken) });
		expect(creds.status).toBe(200);

		// Managing connected agents stays human-only.
		const manage = await app.request('/api/agent-connections', { headers: authHeader(agentToken) });
		expect(manage.status).toBe(403);
	});
});

describe('disconnect', () => {
	it('revokes the token immediately', async () => {
		const { id, token: agentToken } = await registerViaRest('temp-bot');
		await approve(id);
		// Sanity: works before disconnect.
		expect(
			toolPayload(await mcp(agentToken, 'tools/call', { name: 'list_projects', arguments: {} })),
		).toBeInstanceOf(Array);

		const del = await app.request(`/api/agent-connections/${id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(del.status).toBe(200);

		// Immediately rejected on the next request — no token cache.
		const after = await mcp(agentToken, 'tools/call', { name: 'list_projects', arguments: {} });
		expect(after.error.message).toContain('Not connected');

		const status = await app.request('/api/agent-connections/status', {
			headers: authHeader(agentToken),
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
		expect(registered.token).toMatch(/^hezoc_/);
		expect(registered.status).toBe('pending');

		const status = toolPayload(
			await mcp(registered.token, 'tools/call', { name: 'connection_status', arguments: {} }),
		);
		expect(status.status).toBe('pending');
	});
});

describe('locked instance', () => {
	it('denies an approved connected-agent token while locked', async () => {
		const { id, token: agentToken } = await registerViaRest('locked-bot');
		await approve(id);

		// A fresh manager over the same DB starts locked (no key material).
		const locked = await restartTestApp(db, dataDir);
		expect(locked.masterKeyManager.getState()).toBe('locked');

		const res = await mcp(
			agentToken,
			'tools/call',
			{ name: 'list_projects', arguments: {} },
			locked.app,
		);
		expect(res.error).toBeDefined();

		const rest = await locked.app.request(`/api/projects/${slugA}/tasks`, {
			headers: authHeader(agentToken),
		});
		expect(rest.status).toBe(401);
	});
});
