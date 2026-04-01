import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog } from '../../lib/audit';
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
		body: JSON.stringify({ name: 'Audit Co', issue_prefix: 'AUD' }),
	});
	companyId = (await companyRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('audit log', () => {
	it('inserts an audit entry via helper', async () => {
		await auditLog(db, companyId, 'board', null, 'created', 'issue', null, {
			title: 'Test',
		});

		const res = await app.request(`/api/companies/${companyId}/audit-log`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBeGreaterThanOrEqual(1);
		const entry = body.data.find(
			(e: Record<string, unknown>) => e.action === 'created' && e.entity_type === 'issue',
		);
		expect(entry).toBeDefined();
		expect(entry.details).toEqual({ title: 'Test' });
	});

	it('filters by entity_type', async () => {
		await auditLog(db, companyId, 'system', null, 'updated', 'agent', null);

		const res = await app.request(`/api/companies/${companyId}/audit-log?entity_type=agent`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.every((e: Record<string, unknown>) => e.entity_type === 'agent')).toBe(true);
	});

	it('filters by action', async () => {
		await auditLog(db, companyId, 'board', null, 'deleted', 'project', null);

		const res = await app.request(`/api/companies/${companyId}/audit-log?action=deleted`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBeGreaterThanOrEqual(1);
		expect(body.data.every((e: Record<string, unknown>) => e.action === 'deleted')).toBe(true);
	});

	it('filters by date range', async () => {
		const future = new Date(Date.now() + 86400000).toISOString();
		const res = await app.request(`/api/companies/${companyId}/audit-log?from=${future}`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data).toEqual([]);
	});

	it('supports pagination', async () => {
		// Insert several entries
		for (let i = 0; i < 5; i++) {
			await auditLog(db, companyId, 'system', null, 'created', 'issue', null, { i });
		}

		const res = await app.request(`/api/companies/${companyId}/audit-log?page=1&per_page=2`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBeLessThanOrEqual(2);
		expect(body.meta).toBeDefined();
		expect(body.meta.page).toBe(1);
		expect(body.meta.per_page).toBe(2);
		expect(body.meta.total).toBeGreaterThanOrEqual(5);
	});
});
