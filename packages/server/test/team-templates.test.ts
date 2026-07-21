import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
});

afterAll(async () => {
	await safeClose(db);
});

describe('team types CRUD', () => {
	it('lists team types including the built-in one', async () => {
		const res = await app.request('/api/team-templates', {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBeGreaterThanOrEqual(1);
		// Blank is now the only built-in template surfaced by the API; the specialist
		// roster ("App Team") comes from the marketplace (seeded here as a test fixture,
		// non-builtin) rather than being baked into the binary seed.
		const blank = body.data.find((t: Record<string, unknown>) => t.name === 'Blank');
		expect(blank).toBeDefined();
		expect(blank.is_builtin).toBe(true);
		const startup = body.data.find((t: Record<string, unknown>) => t.name === 'App Team');
		expect(startup).toBeDefined();
		expect(startup.agent_types).toHaveLength(10);
	});

	it('builtin App Team type seeds every agent with a substantive system prompt', async () => {
		const res = await app.request('/api/team-templates', {
			headers: authHeader(token),
		});
		const types = (await res.json()).data;
		const builtin = types.find((t: Record<string, unknown>) => t.name === 'App Team');

		const expectedSlugs = [
			'captain',
			'architect',
			'product-lead',
			'engineer',
			'qa-engineer',
			'ui-designer',
			'devops-engineer',
			'marketing-lead',
			'researcher',
			'security-engineer',
		];
		for (const slug of expectedSlugs) {
			const agent = builtin.agent_types.find((a: Record<string, unknown>) => a.slug === slug);
			expect(agent, `agent slug ${slug} should be seeded`).toBeTruthy();
			expect(typeof agent.system_prompt).toBe('string');
			expect(agent.system_prompt.length).toBeGreaterThan(100);
		}

		const captain = builtin.agent_types.find((a: Record<string, unknown>) => a.slug === 'captain');
		expect(captain.system_prompt).toContain('You are the Captain of');
		expect(captain.system_prompt).toContain('{{team_name}}');
		expect(captain.system_prompt).toMatch(/##\s+Rules\b/);

		const engineer = builtin.agent_types.find(
			(a: Record<string, unknown>) => a.slug === 'engineer',
		);
		expect(engineer.system_prompt).toContain('You are an Engineer at');
		expect(engineer.system_prompt).toContain('{{reports_to}}');
	});

	it('creates a custom team type', async () => {
		const res = await app.request('/api/team-templates', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Marketing Agency',
				description: 'A marketing-focused team',
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.name).toBe('Marketing Agency');
		expect(body.data.is_builtin).toBe(false);
		expect(body.data.agent_types).toHaveLength(0);
	});

	it('gets a team type by id', async () => {
		const listRes = await app.request('/api/team-templates', {
			headers: authHeader(token),
		});
		const types = (await listRes.json()).data;
		const id = types[0].id;

		const res = await app.request(`/api/team-templates/${id}`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.id).toBe(id);
		expect(body.data).toHaveProperty('agent_types');
	});

	it('updates a custom team type', async () => {
		const createRes = await app.request('/api/team-templates', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Updatable Type' }),
		});
		const created = (await createRes.json()).data;

		const res = await app.request(`/api/team-templates/${created.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ description: 'Updated description' }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.description).toBe('Updated description');
	});

	it('deletes a custom team type', async () => {
		const createRes = await app.request('/api/team-templates', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Deletable Type' }),
		});
		const created = (await createRes.json()).data;

		const res = await app.request(`/api/team-templates/${created.id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);

		const getRes = await app.request(`/api/team-templates/${created.id}`, {
			headers: authHeader(token),
		});
		expect(getRes.status).toBe(404);
	});

	it('prevents deleting built-in team types', async () => {
		const listRes = await app.request('/api/team-templates', {
			headers: authHeader(token),
		});
		const builtin = (await listRes.json()).data.find((t: Record<string, unknown>) => t.is_builtin);

		const res = await app.request(`/api/team-templates/${builtin.id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(403);
	});

	it('returns 400 for missing name', async () => {
		const res = await app.request('/api/team-templates', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ description: 'No name' }),
		});
		expect(res.status).toBe(400);
	});

	it('updates agent type associations via PATCH', async () => {
		const agentTypesRes = await app.request('/api/agent-types', {
			headers: authHeader(token),
		});
		const allTypes = (await agentTypesRes.json()).data;
		const ceoType = allTypes.find((t: any) => t.slug === 'captain');

		const createRes = await app.request('/api/team-templates', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Patchable Type' }),
		});
		const created = (await createRes.json()).data;
		expect(created.agent_types).toHaveLength(0);

		const patchRes = await app.request(`/api/team-templates/${created.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				agent_types: [{ agent_type_id: ceoType.id, sort_order: 0 }],
			}),
		});
		expect(patchRes.status).toBe(200);
		const patched = (await patchRes.json()).data;
		expect(patched.agent_types).toHaveLength(1);
		expect(patched.agent_types[0].slug).toBe('captain');
	});
});
