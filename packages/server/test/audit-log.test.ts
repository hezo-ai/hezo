import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog } from '../src/lib/audit';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let teamId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const teamRes = await app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Audit Co' }),
	});
	teamId = (await teamRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('audit log', () => {
	it('inserts an audit entry via helper', async () => {
		await auditLog(db, teamId, 'admin', null, 'created', 'task', null, {
			title: 'Test',
		});

		const res = await app.request(`/api/teams/${teamId}/audit-log`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBeGreaterThanOrEqual(1);
		const entry = body.data.find(
			(e: Record<string, unknown>) => e.action === 'created' && e.entity_type === 'task',
		);
		expect(entry).toBeDefined();
		expect(entry.details).toEqual({ title: 'Test' });
	});

	it('filters by entity_type', async () => {
		await auditLog(db, teamId, 'system', null, 'updated', 'agent', null);

		const res = await app.request(`/api/teams/${teamId}/audit-log?entity_type=agent`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.every((e: Record<string, unknown>) => e.entity_type === 'agent')).toBe(true);
	});

	it('filters by action', async () => {
		await auditLog(db, teamId, 'admin', null, 'deleted', 'project', null);

		const res = await app.request(`/api/teams/${teamId}/audit-log?action=deleted`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBeGreaterThanOrEqual(1);
		expect(body.data.every((e: Record<string, unknown>) => e.action === 'deleted')).toBe(true);
	});

	it('filters by date range', async () => {
		const future = new Date(Date.now() + 86400000).toISOString();
		const res = await app.request(`/api/teams/${teamId}/audit-log?from=${future}`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data).toEqual([]);
	});

	it('supports pagination', async () => {
		// Insert several entries
		for (let i = 0; i < 5; i++) {
			await auditLog(db, teamId, 'system', null, 'created', 'task', null, { i });
		}

		const res = await app.request(`/api/teams/${teamId}/audit-log?page=1&per_page=2`, {
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
