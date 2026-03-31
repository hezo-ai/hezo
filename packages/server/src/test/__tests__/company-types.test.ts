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

describe('company types CRUD', () => {
	it('lists company types including the built-in one', async () => {
		const res = await app.request('/api/company-types', {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBeGreaterThanOrEqual(1);
		const builtin = body.data.find((t: any) => t.name === 'Software Development');
		expect(builtin).toBeDefined();
		expect(builtin.is_builtin).toBe(true);
	});

	it('creates a custom company type', async () => {
		const res = await app.request('/api/company-types', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Marketing Agency',
				description: 'A marketing-focused company',
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.name).toBe('Marketing Agency');
		expect(body.data.is_builtin).toBe(false);
	});

	it('gets a company type by id', async () => {
		// First list to get an ID
		const listRes = await app.request('/api/company-types', {
			headers: authHeader(token),
		});
		const types = (await listRes.json()).data;
		const id = types[0].id;

		const res = await app.request(`/api/company-types/${id}`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.id).toBe(id);
	});

	it('updates a custom company type', async () => {
		// Create one
		const createRes = await app.request('/api/company-types', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Updatable Type' }),
		});
		const created = (await createRes.json()).data;

		const res = await app.request(`/api/company-types/${created.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ description: 'Updated description' }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.description).toBe('Updated description');
	});

	it('deletes a custom company type', async () => {
		const createRes = await app.request('/api/company-types', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Deletable Type' }),
		});
		const created = (await createRes.json()).data;

		const res = await app.request(`/api/company-types/${created.id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);

		// Verify it's gone
		const getRes = await app.request(`/api/company-types/${created.id}`, {
			headers: authHeader(token),
		});
		expect(getRes.status).toBe(404);
	});

	it('prevents deleting built-in company types', async () => {
		const listRes = await app.request('/api/company-types', {
			headers: authHeader(token),
		});
		const builtin = (await listRes.json()).data.find((t: any) => t.is_builtin);

		const res = await app.request(`/api/company-types/${builtin.id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(403);
	});

	it('returns 401 without auth', async () => {
		const res = await app.request('/api/company-types');
		expect(res.status).toBe(401);
	});

	it('returns 400 for missing name', async () => {
		const res = await app.request('/api/company-types', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ description: 'No name' }),
		});
		expect(res.status).toBe(400);
	});
});
