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

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const typesRes = await app.request('/api/company-types', {
		headers: authHeader(token),
	});
	const typeId = (await typesRes.json()).data.find((t: any) => t.is_builtin).id;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name: 'Approval Co',
			company_type_id: typeId,
			issue_prefix: 'AC',
		}),
	});
	companyId = (await companyRes.json()).data.id;

	const agentsRes = await app.request(`/api/companies/${companyId}/agents`, {
		headers: authHeader(token),
	});
	agentId = (await agentsRes.json()).data[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('approvals CRUD', () => {
	it('creates and resolves an approval', async () => {
		// Create
		const createRes = await app.request(`/api/companies/${companyId}/approvals`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				type: 'secret_access',
				requested_by_member_id: agentId,
				payload: { secret_name: 'DB_PASSWORD', reason: 'Need for migration' },
			}),
		});
		expect(createRes.status).toBe(201);
		const approval = (await createRes.json()).data;
		expect(approval.status).toBe('pending');

		// List pending
		const listRes = await app.request(`/api/companies/${companyId}/approvals`, {
			headers: authHeader(token),
		});
		expect(listRes.status).toBe(200);
		expect((await listRes.json()).data.length).toBeGreaterThanOrEqual(1);

		// Approve
		const resolveRes = await app.request(`/api/approvals/${approval.id}/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				status: 'approved',
				resolution_note: 'Granted for project scope',
			}),
		});
		expect(resolveRes.status).toBe(200);
		const resolved = (await resolveRes.json()).data;
		expect(resolved.status).toBe('approved');
		expect(resolved.resolved_at).not.toBeNull();
	});

	it('rejects resolving an already-resolved approval', async () => {
		// Create and resolve
		const createRes = await app.request(`/api/companies/${companyId}/approvals`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				type: 'hire',
				requested_by_member_id: agentId,
				payload: { title: 'New Agent' },
			}),
		});
		const approval = (await createRes.json()).data;

		await app.request(`/api/approvals/${approval.id}/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'denied' }),
		});

		// Try again
		const res = await app.request(`/api/approvals/${approval.id}/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'approved' }),
		});
		expect(res.status).toBe(409);
	});
});
