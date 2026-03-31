import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../lib/types';
import { safeClose } from '../helpers';
import { authHeader, createTestApp } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let builtinTypeId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	// Get the built-in type ID for company creation
	const res = await app.request('/api/company-types', {
		headers: authHeader(token),
	});
	const types = (await res.json()).data;
	builtinTypeId = types.find((t: any) => t.is_builtin).id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('companies CRUD', () => {
	it('creates a company from built-in type with auto-created agents', async () => {
		const res = await app.request('/api/companies', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'NoteGenius AI',
				mission: 'Build the #1 AI note-taking app',
				company_type_id: builtinTypeId,
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.name).toBe('NoteGenius AI');
		expect(body.data.issue_prefix).toBe('NA');
		expect(body.data.agent_count).toBe(9);
	});

	it('creates a company without a type', async () => {
		const res = await app.request('/api/companies', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Solo Project',
				issue_prefix: 'SOLO',
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.issue_prefix).toBe('SOLO');
		expect(body.data.agent_count).toBe(0);
	});

	it('rejects duplicate issue prefix', async () => {
		const res = await app.request('/api/companies', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Another Company',
				issue_prefix: 'SOLO',
			}),
		});
		expect(res.status).toBe(409);
	});

	it('lists companies with counts', async () => {
		const res = await app.request('/api/companies', {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBeGreaterThanOrEqual(2);
		expect(body.data[0]).toHaveProperty('agent_count');
		expect(body.data[0]).toHaveProperty('open_issue_count');
	});

	it('gets a company by id', async () => {
		const listRes = await app.request('/api/companies', {
			headers: authHeader(token),
		});
		const companies = (await listRes.json()).data;
		const id = companies[0].id;

		const res = await app.request(`/api/companies/${id}`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.id).toBe(id);
	});

	it('updates a company', async () => {
		const listRes = await app.request('/api/companies', {
			headers: authHeader(token),
		});
		const company = (await listRes.json()).data[0];

		const res = await app.request(`/api/companies/${company.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ mission: 'Updated mission' }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.mission).toBe('Updated mission');
	});

	it('deletes a company', async () => {
		// Create a throwaway company
		const createRes = await app.request('/api/companies', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'To Delete', issue_prefix: 'DEL' }),
		});
		const created = (await createRes.json()).data;

		const res = await app.request(`/api/companies/${created.id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);

		const getRes = await app.request(`/api/companies/${created.id}`, {
			headers: authHeader(token),
		});
		expect(getRes.status).toBe(404);
	});

	it('auto-derives issue prefix from company name', async () => {
		const res = await app.request('/api/companies', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Acme Corp Industries' }),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.issue_prefix).toBe('ACI');
	});
});
