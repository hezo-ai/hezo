import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../lib/types';
import { safeClose } from '../helpers';
import { authHeader, createTestApp } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let companyId: string;
let agentId: string;
let projectId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	// Create a company with Startup template
	const typesRes = await app.request('/api/company-types', {
		headers: authHeader(token),
	});
	const typeId = (await typesRes.json()).data.find((t: any) => t.name === 'Startup').id;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name: 'Secret Extended Co',
			template_id: typeId,
			issue_prefix: 'SEC',
		}),
	});
	companyId = (await companyRes.json()).data.id;

	// Get an agent ID
	const agentsRes = await app.request(`/api/companies/${companyId}/agents`, {
		headers: authHeader(token),
	});
	agentId = (await agentsRes.json()).data[0].id;

	// Create a project
	const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Test Project', description: 'Test project.' }),
	});
	projectId = (await projectRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('secrets PATCH (update)', () => {
	let secretId: string;

	beforeAll(async () => {
		const res = await app.request(`/api/companies/${companyId}/secrets`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'PATCH_SECRET',
				value: 'original-value',
				category: 'api_token',
			}),
		});
		secretId = (await res.json()).data.id;
	});

	it('updates value only', async () => {
		const res = await app.request(`/api/companies/${companyId}/secrets/${secretId}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ value: 'new-value' }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.id).toBe(secretId);
		// Value must not be returned
		expect(body.data).not.toHaveProperty('encrypted_value');
		expect(body.data).not.toHaveProperty('value');
	});

	it('updates category only', async () => {
		const res = await app.request(`/api/companies/${companyId}/secrets/${secretId}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ category: 'credential' }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.category).toBe('credential');
	});

	it('updates both value and category', async () => {
		const res = await app.request(`/api/companies/${companyId}/secrets/${secretId}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ value: 'updated-value', category: 'api_token' }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.category).toBe('api_token');
	});

	it('returns 404 when secret does not exist', async () => {
		const fakeId = '00000000-0000-0000-0000-000000000000';
		const res = await app.request(`/api/companies/${companyId}/secrets/${fakeId}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ value: 'irrelevant' }),
		});
		expect(res.status).toBe(404);
	});
});

describe('secrets GET with project_id filter', () => {
	let secretWithProjectId: string;
	let secretNoProjectId: string;

	beforeAll(async () => {
		// Create a secret scoped to the project
		const res1 = await app.request(`/api/companies/${companyId}/secrets`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'PROJECT_SCOPED_SECRET',
				value: 'proj-val',
				project_id: projectId,
			}),
		});
		secretWithProjectId = (await res1.json()).data.id;

		// Create a secret with no project
		const res2 = await app.request(`/api/companies/${companyId}/secrets`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'GLOBAL_SECRET',
				value: 'global-val',
			}),
		});
		secretNoProjectId = (await res2.json()).data.id;
	});

	it('returns all secrets when no project_id filter', async () => {
		const res = await app.request(`/api/companies/${companyId}/secrets`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		const ids = body.data.map((s: any) => s.id);
		expect(ids).toContain(secretWithProjectId);
		expect(ids).toContain(secretNoProjectId);
	});

	it('returns only project-scoped secrets when project_id filter is given', async () => {
		const res = await app.request(`/api/companies/${companyId}/secrets?project_id=${projectId}`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		const ids = body.data.map((s: any) => s.id);
		expect(ids).toContain(secretWithProjectId);
		expect(ids).not.toContain(secretNoProjectId);
		// All returned secrets must belong to the requested project
		for (const secret of body.data) {
			expect(secret.project_id).toBe(projectId);
		}
	});
});

describe('GET /companies/:companyId/secrets/:secretId/grants', () => {
	let secretId: string;

	beforeAll(async () => {
		const res = await app.request(`/api/companies/${companyId}/secrets`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'GRANTS_LIST_SECRET', value: 'val' }),
		});
		secretId = (await res.json()).data.id;
	});

	it('returns empty grants list when no grants exist', async () => {
		const res = await app.request(`/api/companies/${companyId}/secrets/${secretId}/grants`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data).toHaveLength(0);
	});

	it('returns grants after one is created', async () => {
		await app.request(`/api/companies/${companyId}/secrets/${secretId}/grants`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ agent_id: agentId, scope: 'company' }),
		});

		const res = await app.request(`/api/companies/${companyId}/secrets/${secretId}/grants`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data).toHaveLength(1);
		expect(body.data[0].scope).toBe('company');
		expect(body.data[0].agent_id).toBe(agentId);
		expect(body.data[0]).toHaveProperty('granted_at');
	});
});

describe('secrets validation', () => {
	it('returns 400 when name is missing on create', async () => {
		const res = await app.request(`/api/companies/${companyId}/secrets`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ value: 'some-value' }),
		});
		expect(res.status).toBe(400);
	});

	it('returns 400 when value is missing on create', async () => {
		const res = await app.request(`/api/companies/${companyId}/secrets`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'NO_VALUE_SECRET' }),
		});
		expect(res.status).toBe(400);
	});

	it('returns 400 when both name and value are missing on create', async () => {
		const res = await app.request(`/api/companies/${companyId}/secrets`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ category: 'api_token' }),
		});
		expect(res.status).toBe(400);
	});

	it('returns 400 when name is blank (whitespace only) on create', async () => {
		const res = await app.request(`/api/companies/${companyId}/secrets`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: '   ', value: 'some-value' }),
		});
		expect(res.status).toBe(400);
	});
});

describe('secrets DELETE 404', () => {
	it('returns 404 when deleting a non-existent secret', async () => {
		const fakeId = '00000000-0000-0000-0000-000000000001';
		const res = await app.request(`/api/companies/${companyId}/secrets/${fakeId}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(404);
	});
});

describe('secret grant revoke 404', () => {
	it('returns 404 when revoking a non-existent grant', async () => {
		const fakeGrantId = '00000000-0000-0000-0000-000000000002';
		const res = await app.request(`/api/companies/${companyId}/secret-grants/${fakeGrantId}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(404);
	});
});
