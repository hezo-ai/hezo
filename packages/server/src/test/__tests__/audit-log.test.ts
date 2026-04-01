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
});
