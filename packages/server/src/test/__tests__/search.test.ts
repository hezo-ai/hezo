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

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const typesRes = await app.request('/api/company-types', {
		headers: authHeader(token),
	});
	const typeId = (await typesRes.json()).data.find(
		(t: Record<string, unknown>) => t.name === 'Startup',
	).id;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Search Test Co', template_id: typeId }),
	});
	companyId = (await companyRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('GET /companies/:companyId/search', () => {
	it('returns 400 when q parameter is missing', async () => {
		const res = await app.request(`/api/companies/${companyId}/search`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBeDefined();
	});

	it('returns 400 when q parameter is empty', async () => {
		const res = await app.request(`/api/companies/${companyId}/search?q=`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(400);
	});

	it('returns 400 when q parameter is whitespace', async () => {
		const res = await app.request(`/api/companies/${companyId}/search?q=%20%20`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(400);
	});

	it('returns empty results with loading message when model is not ready', async () => {
		const res = await app.request(`/api/companies/${companyId}/search?q=test+query`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.results).toEqual([]);
		expect(body.data.message).toContain('Embedding model is loading');
	});

	it('passes scope parameter through', async () => {
		const res = await app.request(`/api/companies/${companyId}/search?q=hello&scope=kb_docs`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.results).toEqual([]);
	});

	it('passes limit parameter through', async () => {
		const res = await app.request(`/api/companies/${companyId}/search?q=hello&limit=5`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
	});

	it('requires authentication', async () => {
		const res = await app.request(`/api/companies/${companyId}/search?q=test`);
		expect(res.status).toBe(401);
	});

	it('handles non-existent company gracefully', async () => {
		const res = await app.request(
			'/api/companies/00000000-0000-0000-0000-000000000099/search?q=test',
			{ headers: authHeader(token) },
		);
		// Superuser has access to any company — the search just returns empty
		// because the embedding model isn't loaded
		expect(res.status).toBe(200);
	});
});
