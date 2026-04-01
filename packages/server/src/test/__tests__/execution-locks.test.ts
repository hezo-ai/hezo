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
let projectId: string;
let issueId: string;
let agentId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const typesRes = await app.request('/api/company-types', { headers: authHeader(token) });
	const companyTypeId = (await typesRes.json()).data[0].id;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name: 'Lock Test Co',
			issue_prefix: 'LTC',
			company_type_id: companyTypeId,
		}),
	});
	companyId = (await companyRes.json()).data.id;

	const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Lock Test Project' }),
	});
	projectId = (await projectRes.json()).data.id;

	const issueRes = await app.request(`/api/companies/${companyId}/issues`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: projectId, title: 'Lock Test Issue' }),
	});
	issueId = (await issueRes.json()).data.id;

	const agentsRes = await app.request(`/api/companies/${companyId}/agents`, {
		headers: authHeader(token),
	});
	agentId = (await agentsRes.json()).data[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('execution locks', () => {
	it('returns null when no lock exists', async () => {
		const res = await app.request(`/api/companies/${companyId}/issues/${issueId}/lock`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data).toBeNull();
	});

	it('creates a lock', async () => {
		const res = await app.request(`/api/companies/${companyId}/issues/${issueId}/lock`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ member_id: agentId }),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.issue_id).toBe(issueId);
		expect(body.data.member_id).toBe(agentId);
	});

	it('prevents double-locking', async () => {
		const res = await app.request(`/api/companies/${companyId}/issues/${issueId}/lock`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ member_id: agentId }),
		});
		expect(res.status).toBe(409);
	});

	it('returns the active lock', async () => {
		const res = await app.request(`/api/companies/${companyId}/issues/${issueId}/lock`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.member_id).toBe(agentId);
		expect(body.data).toHaveProperty('member_name');
	});

	it('releases the lock', async () => {
		const res = await app.request(`/api/companies/${companyId}/issues/${issueId}/lock`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);

		const checkRes = await app.request(`/api/companies/${companyId}/issues/${issueId}/lock`, {
			headers: authHeader(token),
		});
		expect((await checkRes.json()).data).toBeNull();
	});

	it('allows re-locking after release', async () => {
		const res = await app.request(`/api/companies/${companyId}/issues/${issueId}/lock`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ member_id: agentId }),
		});
		expect(res.status).toBe(201);
	});
});
