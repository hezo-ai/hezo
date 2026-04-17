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
let secondAgentId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const typesRes = await app.request('/api/company-types', { headers: authHeader(token) });
	const companyTypeId = (await typesRes.json()).data.find((t: any) => t.name === 'Startup').id;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name: 'Lock Test Co',
			issue_prefix: 'LTC',
			template_id: companyTypeId,
		}),
	});
	companyId = (await companyRes.json()).data.id;

	const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Lock Test Project', description: 'Test project.' }),
	});
	projectId = (await projectRes.json()).data.id;

	const agentsRes = await app.request(`/api/companies/${companyId}/agents`, {
		headers: authHeader(token),
	});
	const agents = (await agentsRes.json()).data;
	agentId = agents[0].id;
	secondAgentId = agents[1].id;

	const issueRes = await app.request(`/api/companies/${companyId}/issues`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: projectId, title: 'Lock Test Issue', assignee_id: agentId }),
	});
	issueId = (await issueRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('execution locks', () => {
	it('returns empty locks when no lock exists', async () => {
		const res = await app.request(`/api/companies/${companyId}/issues/${issueId}/lock`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.locks).toEqual([]);
		expect(body.data.has_write_lock).toBe(false);
	});

	it('creates a write lock (default)', async () => {
		const res = await app.request(`/api/companies/${companyId}/issues/${issueId}/lock`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ member_id: agentId }),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.issue_id).toBe(issueId);
		expect(body.data.member_id).toBe(agentId);
		expect(body.data.lock_type).toBe('write');
	});

	it('prevents another write lock while write lock active', async () => {
		const res = await app.request(`/api/companies/${companyId}/issues/${issueId}/lock`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ member_id: secondAgentId }),
		});
		expect(res.status).toBe(409);
	});

	it('prevents read lock while write lock active', async () => {
		const res = await app.request(`/api/companies/${companyId}/issues/${issueId}/lock`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ member_id: secondAgentId, lock_type: 'read' }),
		});
		expect(res.status).toBe(409);
	});

	it('returns active locks with lock_type', async () => {
		const res = await app.request(`/api/companies/${companyId}/issues/${issueId}/lock`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.locks.length).toBe(1);
		expect(body.data.locks[0].member_id).toBe(agentId);
		expect(body.data.locks[0].lock_type).toBe('write');
		expect(body.data.has_write_lock).toBe(true);
		expect(body.data.locks[0]).toHaveProperty('member_name');
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
		const body = await checkRes.json();
		expect(body.data.locks).toEqual([]);
	});

	it('allows re-locking after release', async () => {
		const res = await app.request(`/api/companies/${companyId}/issues/${issueId}/lock`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ member_id: agentId }),
		});
		expect(res.status).toBe(201);

		// Clean up for read lock tests
		await app.request(`/api/companies/${companyId}/issues/${issueId}/lock`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
	});

	it('allows multiple read locks on same issue', async () => {
		const res1 = await app.request(`/api/companies/${companyId}/issues/${issueId}/lock`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ member_id: agentId, lock_type: 'read' }),
		});
		expect(res1.status).toBe(201);
		expect((await res1.json()).data.lock_type).toBe('read');

		const res2 = await app.request(`/api/companies/${companyId}/issues/${issueId}/lock`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ member_id: secondAgentId, lock_type: 'read' }),
		});
		expect(res2.status).toBe(201);
		expect((await res2.json()).data.lock_type).toBe('read');

		// Verify both locks exist
		const checkRes = await app.request(`/api/companies/${companyId}/issues/${issueId}/lock`, {
			headers: authHeader(token),
		});
		const body = await checkRes.json();
		expect(body.data.locks.length).toBe(2);
		expect(body.data.has_write_lock).toBe(false);
	});

	it('prevents write lock while read locks active', async () => {
		const res = await app.request(`/api/companies/${companyId}/issues/${issueId}/lock`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ member_id: agentId }),
		});
		expect(res.status).toBe(409);
	});
});
