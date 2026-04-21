import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../../crypto/master-key';
import type { Env } from '../../lib/types';
import { safeClose } from '../helpers';
import { authHeader, createTestApp, finalizeAgentRun, mintAgentToken } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let masterKeyManager: MasterKeyManager;
let companyId: string;
let agentId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const typesRes = await app.request('/api/company-types', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find((t: any) => t.name === 'Startup').id;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'MCP Test Co', template_id: typeId, issue_prefix: 'MCP' }),
	});
	companyId = (await companyRes.json()).data.id;

	const agentsRes = await app.request(`/api/companies/${companyId}/agents`, {
		headers: authHeader(token),
	});
	agentId = (await agentsRes.json()).data[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('skill file', () => {
	it('returns markdown at /skill.md', async () => {
		const res = await app.request('/skill.md');
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toContain('# Hezo Skill File');
		expect(text).toContain('list_companies');
		expect(text).toContain('create_issue');
	});
});

describe('MCP endpoint', () => {
	it('rejects unauthenticated requests', async () => {
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 }),
		});
		expect(res.status).toBe(401);
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
		expect(toolNames).toContain('list_companies');
		expect(toolNames).toContain('create_issue');
	});

	it('calls a tool and receives auth context (not missing-auth error)', async () => {
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'tools/call',
				params: { name: 'list_companies', arguments: {} },
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
				params: { name: 'list_agents', arguments: { company_id: companyId } },
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
		const { token: agentToken } = await mintAgentToken(db, masterKeyManager, agentId, companyId);
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'tools/call',
				params: { name: 'list_companies', arguments: {} },
				id: 5,
			}),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		const payload = JSON.parse(body.result.content[0].text);
		expect(payload).not.toHaveProperty('error');
		expect(Array.isArray(payload)).toBe(true);
	});

	it('rejects an agent token once its run has finalized', async () => {
		const { token: agentToken, runId } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			companyId,
		);
		await finalizeAgentRun(db, runId, 'succeeded');

		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'tools/call',
				params: { name: 'list_companies', arguments: {} },
				id: 6,
			}),
		});
		expect(res.status).toBe(401);
	});
});
