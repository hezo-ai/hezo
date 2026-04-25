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

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'KB Test Co' }),
	});
	companyId = (await companyRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('KB docs CRUD', () => {
	it('creates a KB doc', async () => {
		const res = await app.request(`/api/companies/${companyId}/kb-docs`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				title: 'Coding Standards',
				content: '# Coding Standards\n\nUse TypeScript.',
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.title).toBe('Coding Standards');
		expect(body.data.slug).toBe('coding-standards.md');
		expect(body.data.content).toBe('# Coding Standards\n\nUse TypeScript.');
	});

	it('lists KB docs', async () => {
		const res = await app.request(`/api/companies/${companyId}/kb-docs`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBeGreaterThanOrEqual(1);
		expect(body.data[0]).toHaveProperty('title');
		expect(body.data[0]).toHaveProperty('slug');
	});

	it('gets a KB doc by slug', async () => {
		const res = await app.request(`/api/companies/${companyId}/kb-docs/coding-standards.md`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.title).toBe('Coding Standards');
		expect(body.data.content).toContain('TypeScript');
	});

	it('returns 404 for non-existent slug', async () => {
		const res = await app.request(`/api/companies/${companyId}/kb-docs/non-existent.md`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(404);
	});

	it('updates a KB doc and creates revision', async () => {
		const res = await app.request(`/api/companies/${companyId}/kb-docs/coding-standards.md`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content: '# Coding Standards\n\nUse TypeScript. Prefer functional patterns.',
				change_summary: 'Added functional patterns preference',
			}),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.content).toContain('functional patterns');

		// Check revision was created
		const revRes = await app.request(
			`/api/companies/${companyId}/kb-docs/coding-standards.md/revisions`,
			{ headers: authHeader(token) },
		);
		expect(revRes.status).toBe(200);
		const revBody = await revRes.json();
		expect(revBody.data.length).toBe(1);
		expect(revBody.data[0].content).toContain('Use TypeScript.');
		expect(revBody.data[0].change_summary).toBe('Added functional patterns preference');
	});

	it('restores a KB doc to a previous revision', async () => {
		// Update again to create a second revision
		await app.request(`/api/companies/${companyId}/kb-docs/coding-standards.md`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content: '# Coding Standards v3',
				change_summary: 'Version 3',
			}),
		});

		// Restore to revision 1 (original content before first update)
		const restoreRes = await app.request(
			`/api/companies/${companyId}/kb-docs/coding-standards.md/restore`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ revision_number: 1 }),
			},
		);
		expect(restoreRes.status).toBe(200);
		const restored = await restoreRes.json();
		expect(restored.data.content).toBe('# Coding Standards\n\nUse TypeScript.');

		// Verify a new revision was created for the pre-restore content
		const revRes = await app.request(
			`/api/companies/${companyId}/kb-docs/coding-standards.md/revisions`,
			{ headers: authHeader(token) },
		);
		const revBody = await revRes.json();
		expect(revBody.data.length).toBe(3);
		expect(revBody.data[0].change_summary).toBe('Restored to revision 1');
		expect(revBody.data[0].content).toBe('# Coding Standards v3');
	});

	it('returns 404 when restoring non-existent revision', async () => {
		const res = await app.request(
			`/api/companies/${companyId}/kb-docs/coding-standards.md/restore`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ revision_number: 999 }),
			},
		);
		expect(res.status).toBe(404);
	});

	it('deletes a KB doc', async () => {
		// Create one to delete
		await app.request(`/api/companies/${companyId}/kb-docs`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'To Delete' }),
		});

		const deleteRes = await app.request(`/api/companies/${companyId}/kb-docs/to-delete.md`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(deleteRes.status).toBe(200);

		// Verify it's gone
		const getRes = await app.request(`/api/companies/${companyId}/kb-docs/to-delete.md`, {
			headers: authHeader(token),
		});
		expect(getRes.status).toBe(404);
	});
});
