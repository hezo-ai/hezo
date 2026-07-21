import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestTeam,
	finalizeAgentRun,
	mintAgentToken,
	projectSlugFor,
} from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let projectSlug: string;
let agentId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find((t: any) => t.name === 'App Team').id;

	const teamRes = await createTestTeam(db, { name: 'MCP Test Co', template_id: typeId });
	const teamData = (await teamRes.json()).data;
	teamId = teamData.id;

	projectSlug = await projectSlugFor(db, teamData.id);
	const agentsRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		headers: authHeader(token),
	});
	agentId = (await agentsRes.json()).data[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('skill file', () => {
	it('returns markdown at /SKILL.md', async () => {
		const res = await app.request('/SKILL.md');
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toContain('# Hezo Skill File');
		expect(text).toContain('list_teams');
		expect(text).toContain('create_task');
	});
});

describe('MCP endpoint', () => {
	it('serves only the onboarding surface to unauthenticated callers', async () => {
		// initialize is allowed without a token so an agent can begin onboarding.
		const initRes = await app.request('/mcp', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 }),
		});
		expect(initRes.status).toBe(200);

		// tools/list returns only the onboarding tools, not the real surface.
		const listRes = await app.request('/mcp', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 2 }),
		});
		const listBody = await listRes.json();
		const names = listBody.result.tools.map((t: { name: string }) => t.name);
		expect(names).toContain('register');
		expect(names).toContain('connection_status');
		expect(names).not.toContain('create_task');

		// A non-onboarding tool call is refused with a "not connected" error.
		const callRes = await app.request('/mcp', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'tools/call',
				params: { name: 'list_teams', arguments: {} },
				id: 3,
			}),
		});
		const callBody = await callRes.json();
		expect(callBody.error).toBeDefined();
		expect(callBody.error.message).toContain('Not connected');
	});

	it('handles initialize', async () => {
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.result.serverInfo.name).toBe('hezo');
	});

	it('lists tools', async () => {
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 2 }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.result.tools.length).toBeGreaterThan(0);
		const toolNames = body.result.tools.map((t: any) => t.name);
		expect(toolNames).toContain('list_teams');
		expect(toolNames).toContain('create_task');
	});

	it('calls a tool and receives auth context (not missing-auth error)', async () => {
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'tools/call',
				params: { name: 'list_teams', arguments: {} },
				id: 3,
			}),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.result.content[0].type).toBe('text');
		const payload = JSON.parse(body.result.content[0].text);
		expect(payload).not.toHaveProperty('error');
		expect(Array.isArray(payload)).toBe(true);
		expect(payload.length).toBeGreaterThan(0);
	});

	it('passes through non-empty arguments to the tool handler', async () => {
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'tools/call',
				params: { name: 'list_agents', arguments: { project: projectSlug } },
				id: 4,
			}),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		const payload = JSON.parse(body.result.content[0].text);
		expect(payload).not.toHaveProperty('error');
		expect(Array.isArray(payload)).toBe(true);
	});

	it('accepts an agent token whose run is active', async () => {
		const { token: agentToken } = await mintAgentToken(db, masterKeyManager, agentId, teamId);
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'tools/call',
				params: { name: 'list_teams', arguments: {} },
				id: 5,
			}),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		const payload = JSON.parse(body.result.content[0].text);
		expect(payload).not.toHaveProperty('error');
		expect(Array.isArray(payload)).toBe(true);
	});

	it('returns 202 with no body for notifications/initialized (no id)', async () => {
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
		});
		expect(res.status).toBe(202);
		expect(await res.text()).toBe('');
	});

	it('returns 202 with no body for unknown notifications', async () => {
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled' }),
		});
		expect(res.status).toBe(202);
		expect(await res.text()).toBe('');
	});

	it('returns a JSON-RPC error with the original id for unknown request methods', async () => {
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', method: 'totally/unknown', id: 99 }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.id).toBe(99);
		expect(body.error.code).toBe(-32601);
		expect(body.error.message).toContain('totally/unknown');
		expect(body).not.toHaveProperty('result');
	});

	it('returns 405 with Allow: POST on GET', async () => {
		const res = await app.request('/mcp', { method: 'GET', headers: authHeader(token) });
		expect(res.status).toBe(405);
		expect(res.headers.get('Allow')).toBe('POST');
	});

	it('returns 405 with Allow: POST on DELETE', async () => {
		const res = await app.request('/mcp', { method: 'DELETE', headers: authHeader(token) });
		expect(res.status).toBe(405);
		expect(res.headers.get('Allow')).toBe('POST');
	});

	it('rejects an agent token once its run has finalized', async () => {
		const { token: agentToken, runId } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
		);
		await finalizeAgentRun(db, runId, 'succeeded');

		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'tools/call',
				params: { name: 'list_teams', arguments: {} },
				id: 6,
			}),
		});
		// A finalized run's token is no longer a valid principal, so the MCP
		// endpoint treats it as not-connected rather than granting tool access.
		const body = await res.json();
		expect(body.error).toBeDefined();
		expect(body.error.message).toContain('Not connected');
	});
});
