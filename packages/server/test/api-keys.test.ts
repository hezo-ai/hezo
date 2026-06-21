import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestTeam, projectSlugFor } from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let projectSlug: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const teamRes = await createTestTeam(db, { name: 'API Key Co' });
	const team = (await teamRes.json()).data;
	projectSlug = `${await projectSlugFor(db, team.id)}`;
});

afterAll(async () => {
	await safeClose(db);
});

describe('API keys CRUD', () => {
	it('creates an API key and returns raw key once', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/api-keys`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Test Key' }),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.key).toMatch(/^hezo_/);
		expect(body.data.name).toBe('Test Key');
		expect(body.data.prefix).toHaveLength(8);
	});

	it('lists API keys (without raw key)', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/api-keys`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBeGreaterThanOrEqual(1);
		// Raw key should NOT be in list
		expect(body.data[0]).not.toHaveProperty('key');
		expect(body.data[0]).not.toHaveProperty('key_hash');
	});

	it('is rejected on REST but authenticates the MCP endpoint', async () => {
		const createRes = await app.request(`/api/projects/${projectSlug}/api-keys`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Auth Test Key' }),
		});
		const rawKey = (await createRes.json()).data.key;

		// REST is the human/browser surface — API keys are not accepted there.
		const restRes = await app.request(`/api/projects/${projectSlug}/api-keys`, {
			headers: { Authorization: `Bearer ${rawKey}` },
		});
		expect(restRes.status).toBe(401);

		// The same key authenticates the MCP endpoint (the external on-ramp).
		const mcpRes = await app.request('/mcp', {
			method: 'POST',
			headers: { Authorization: `Bearer ${rawKey}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'tools/call',
				params: { name: 'list_tasks', arguments: {} },
				id: 1,
			}),
		});
		expect(mcpRes.status).toBe(200);
		const text = (await mcpRes.json()).result.content[0].text;
		// A real tool result (a JSON array of tasks), not an auth/scope error.
		expect(text).not.toContain('Access denied');
		expect(Array.isArray(JSON.parse(text))).toBe(true);
	});

	it('revokes an API key (MCP access removed)', async () => {
		const createRes = await app.request(`/api/projects/${projectSlug}/api-keys`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'To Revoke' }),
		});
		const apiKey = (await createRes.json()).data;
		const rawKey = apiKey.key;

		const toolNames = async (): Promise<string[]> => {
			const res = await app.request('/mcp', {
				method: 'POST',
				headers: { Authorization: `Bearer ${rawKey}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
			});
			const body = await res.json();
			return (body.result.tools as Array<{ name: string }>).map((t) => t.name);
		};

		// A valid key is a full principal — it sees the real project tools.
		expect(await toolNames()).toContain('list_tasks');

		const res = await app.request(`/api/projects/${projectSlug}/api-keys/${apiKey.id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);

		// After revocation the token is unrecognized, so it drops to the
		// unauthenticated onboarding surface (connect/register tools only).
		expect(await toolNames()).not.toContain('list_tasks');
	});
});
