import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../lib/types';
import { safeClose } from '../helpers';
import { authHeader, createTestApp } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
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

describe('agent types CRUD', () => {
	it('lists all 9 built-in agent types', async () => {
		const res = await app.request('/api/agent-types', {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data).toHaveLength(9);
		expect(body.data.every((t: any) => t.is_builtin === true)).toBe(true);
		expect(body.data.every((t: any) => t.source === 'builtin')).toBe(true);
	});

	it('filters by source', async () => {
		const res = await app.request('/api/agent-types?source=builtin', {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBe(9);

		const customRes = await app.request('/api/agent-types?source=custom', {
			headers: authHeader(token),
		});
		const customBody = await customRes.json();
		expect(customBody.data.length).toBe(0);
	});

	it('creates a custom agent type', async () => {
		const res = await app.request('/api/agent-types', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Data Scientist',
				description: 'ML and data analysis',
				role_description: 'Builds models and analyzes data',
				system_prompt_template: 'You are a data scientist for {{company_name}}.',
				monthly_budget_cents: 5000,
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.name).toBe('Data Scientist');
		expect(body.data.slug).toBe('data-scientist');
		expect(body.data.is_builtin).toBe(false);
		expect(body.data.source).toBe('custom');
		expect(body.data.monthly_budget_cents).toBe(5000);
	});

	it('gets an agent type by id', async () => {
		const listRes = await app.request('/api/agent-types', {
			headers: authHeader(token),
		});
		const types = (await listRes.json()).data;
		const ceoType = types.find((t: any) => t.slug === 'ceo');

		const res = await app.request(`/api/agent-types/${ceoType.id}`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.name).toBe('CEO');
		expect(body.data.system_prompt_template).toBeTruthy();
	});

	it('updates a custom agent type', async () => {
		const createRes = await app.request('/api/agent-types', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Updatable Agent' }),
		});
		const created = (await createRes.json()).data;

		const res = await app.request(`/api/agent-types/${created.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ description: 'Updated desc', monthly_budget_cents: 9999 }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.description).toBe('Updated desc');
		expect(body.data.monthly_budget_cents).toBe(9999);
	});

	it('prevents deleting built-in agent types', async () => {
		const listRes = await app.request('/api/agent-types', {
			headers: authHeader(token),
		});
		const builtin = (await listRes.json()).data.find((t: any) => t.is_builtin);

		const res = await app.request(`/api/agent-types/${builtin.id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(403);
	});

	it('deletes a custom agent type', async () => {
		const createRes = await app.request('/api/agent-types', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Deletable Agent' }),
		});
		const created = (await createRes.json()).data;

		const res = await app.request(`/api/agent-types/${created.id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);

		const getRes = await app.request(`/api/agent-types/${created.id}`, {
			headers: authHeader(token),
		});
		expect(getRes.status).toBe(404);
	});

	it('rejects duplicate slugs', async () => {
		await app.request('/api/agent-types', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Unique Agent' }),
		});

		const res = await app.request('/api/agent-types', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Unique Agent' }),
		});
		expect(res.status).toBe(500);
	});
});

describe('company types with agent types', () => {
	it('built-in company type includes 9 agent types', async () => {
		const res = await app.request('/api/company-types', {
			headers: authHeader(token),
		});
		const body = await res.json();
		const builtin = body.data.find((t: any) => t.is_builtin);
		expect(builtin.agent_types).toHaveLength(9);
		expect(builtin.agent_types[0]).toHaveProperty('agent_type_id');
		expect(builtin.agent_types[0]).toHaveProperty('name');
		expect(builtin.agent_types[0]).toHaveProperty('slug');
	});

	it('creates company type with agent type associations', async () => {
		const agentTypesRes = await app.request('/api/agent-types', {
			headers: authHeader(token),
		});
		const allTypes = (await agentTypesRes.json()).data;
		const ceoType = allTypes.find((t: any) => t.slug === 'ceo');
		const engType = allTypes.find((t: any) => t.slug === 'engineer');

		const res = await app.request('/api/company-types', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Small Team',
				description: 'Just a CEO and Engineer',
				agent_types: [
					{ agent_type_id: ceoType.id, sort_order: 0 },
					{ agent_type_id: engType.id, reports_to_slug: 'ceo', sort_order: 1 },
				],
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.agent_types).toHaveLength(2);
	});
});

describe('company creation with agent types', () => {
	it('creates agents with agent_type_id set', async () => {
		const typesRes = await app.request('/api/company-types', {
			headers: authHeader(token),
		});
		const builtinType = (await typesRes.json()).data.find((t: any) => t.is_builtin);

		const companyRes = await app.request('/api/companies', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Agent Type Test Co',
				company_type_id: builtinType.id,
			}),
		});
		const companyId = (await companyRes.json()).data.id;

		const agentsRes = await app.request(`/api/companies/${companyId}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await agentsRes.json()).data;
		expect(agents).toHaveLength(9);
		expect(agents.every((a: any) => a.agent_type_id != null)).toBe(true);
	});
});
