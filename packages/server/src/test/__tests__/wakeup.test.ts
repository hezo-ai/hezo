import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../lib/types';
import { createWakeup } from '../../services/wakeup';
import { safeClose } from '../helpers';
import { authHeader, createTestApp } from '../helpers/app';

let db: PGlite;
let app: Hono<Env>;
let token: string;
let companyId: string;
let agentId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	app = ctx.app;
	token = ctx.token;

	const typesRes = await app.request('/api/company-types', { headers: authHeader(token) });
	const companyTypeId = (await typesRes.json()).data.find((t: any) => t.name === 'Startup').id;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name: 'Wakeup Co',
			issue_prefix: 'WUC',
			template_id: companyTypeId,
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

describe('wakeup service', () => {
	it('creates a wakeup request', async () => {
		const id = await createWakeup(db, agentId, companyId, 'assignment', {
			issue_id: 'test-issue',
		});
		expect(id).toBeTruthy();

		const result = await db.query('SELECT * FROM agent_wakeup_requests WHERE id = $1', [id]);
		expect(result.rows.length).toBe(1);
		expect((result.rows[0] as any).source).toBe('assignment');
		expect((result.rows[0] as any).status).toBe('queued');
	});

	it('coalesces wakeups within the window', async () => {
		const id1 = await createWakeup(db, agentId, companyId, 'mention', {
			issue_id: 'issue-1',
		});
		const id2 = await createWakeup(db, agentId, companyId, 'mention', {
			issue_id: 'issue-2',
		});

		expect(id2).toBe(id1);

		const result = await db.query<{ coalesced_count: number }>(
			'SELECT coalesced_count FROM agent_wakeup_requests WHERE id = $1',
			[id1],
		);
		expect(result.rows[0].coalesced_count).toBeGreaterThanOrEqual(1);
	});

	it('respects idempotency keys', async () => {
		const id1 = await createWakeup(db, agentId, companyId, 'timer', {}, 'unique-key-1');
		const id2 = await createWakeup(db, agentId, companyId, 'timer', {}, 'unique-key-1');
		expect(id2).toBe(id1);
	});

	it('creates wakeup on issue assignment', async () => {
		const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Wakeup Project' }),
		});
		const projectId = (await projectRes.json()).data.id;

		const issueRes = await app.request(`/api/companies/${companyId}/issues`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ project_id: projectId, title: 'Wakeup Issue' }),
		});
		const issueId = (await issueRes.json()).data.id;

		// Clear existing wakeups
		await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agentId]);

		await app.request(`/api/companies/${companyId}/issues/${issueId}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ assignee_id: agentId }),
		});

		// Small delay for async wakeup creation
		await new Promise((r) => setTimeout(r, 50));

		const wakeups = await db.query(
			"SELECT * FROM agent_wakeup_requests WHERE member_id = $1 AND source = 'assignment'",
			[agentId],
		);
		expect(wakeups.rows.length).toBeGreaterThanOrEqual(1);
	});
});
