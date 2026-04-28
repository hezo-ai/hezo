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

	it('does not coalesce wakeups targeting different issues', async () => {
		await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agentId]);

		const id1 = await createWakeup(db, agentId, companyId, 'mention', {
			issue_id: 'coalesce-issue-a',
		});
		const id2 = await createWakeup(db, agentId, companyId, 'mention', {
			issue_id: 'coalesce-issue-b',
		});

		expect(id2).not.toBe(id1);

		const rows = await db.query<{ id: string; payload: { issue_id: string } }>(
			"SELECT id, payload FROM agent_wakeup_requests WHERE member_id = $1 AND status = 'queued' ORDER BY created_at ASC",
			[agentId],
		);
		const issueIds = rows.rows.map((r) => r.payload.issue_id).sort();
		expect(issueIds).toEqual(['coalesce-issue-a', 'coalesce-issue-b']);
	});

	it('coalesces wakeups for the same issue within the window', async () => {
		await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agentId]);

		const id1 = await createWakeup(db, agentId, companyId, 'mention', {
			issue_id: 'same-issue',
		});
		const id2 = await createWakeup(db, agentId, companyId, 'mention', {
			issue_id: 'same-issue',
		});

		expect(id2).toBe(id1);

		const result = await db.query<{ coalesced_count: number }>(
			'SELECT coalesced_count FROM agent_wakeup_requests WHERE id = $1',
			[id1],
		);
		expect(result.rows[0].coalesced_count).toBeGreaterThanOrEqual(1);
	});

	it('coalesces wakeups that have no issue_id', async () => {
		await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agentId]);

		const id1 = await createWakeup(db, agentId, companyId, 'timer', {
			reason: 'tick-a',
		});
		const id2 = await createWakeup(db, agentId, companyId, 'timer', {
			reason: 'tick-b',
		});

		expect(id2).toBe(id1);
	});

	it('coalesces same-issue wakeups beyond the 2s window and promotes to stronger source', async () => {
		await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agentId]);

		const assignmentId = await createWakeup(db, agentId, companyId, 'assignment', {
			issue_id: 'cross-window-issue',
		});

		await db.query(
			"UPDATE agent_wakeup_requests SET created_at = now() - interval '10 seconds' WHERE id = $1",
			[assignmentId],
		);

		const mentionId = await createWakeup(db, agentId, companyId, 'mention', {
			source: 'mention',
			issue_id: 'cross-window-issue',
			comment_id: 'comment-xyz',
		});

		expect(mentionId).toBe(assignmentId);

		const rows = await db.query<{
			source: string;
			payload: { source?: string; comment_id?: string; issue_id?: string };
			coalesced_count: number;
		}>(
			"SELECT source::text AS source, payload, coalesced_count FROM agent_wakeup_requests WHERE member_id = $1 AND status = 'queued'",
			[agentId],
		);
		expect(rows.rows.length).toBe(1);
		expect(rows.rows[0].source).toBe('mention');
		expect(rows.rows[0].payload.source).toBe('mention');
		expect(rows.rows[0].payload.comment_id).toBe('comment-xyz');
		expect(rows.rows[0].payload.issue_id).toBe('cross-window-issue');
		expect(rows.rows[0].coalesced_count).toBeGreaterThanOrEqual(1);
	});

	it('does not downgrade source when a weaker trigger arrives later', async () => {
		await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agentId]);

		const mentionId = await createWakeup(db, agentId, companyId, 'mention', {
			source: 'mention',
			issue_id: 'no-downgrade-issue',
			comment_id: 'first-mention',
		});

		await db.query(
			"UPDATE agent_wakeup_requests SET created_at = now() - interval '10 seconds' WHERE id = $1",
			[mentionId],
		);

		const assignmentId = await createWakeup(db, agentId, companyId, 'assignment', {
			issue_id: 'no-downgrade-issue',
		});

		expect(assignmentId).toBe(mentionId);

		const row = await db.query<{
			source: string;
			payload: { source?: string; comment_id?: string };
		}>('SELECT source::text AS source, payload FROM agent_wakeup_requests WHERE id = $1', [
			mentionId,
		]);
		expect(row.rows[0].source).toBe('mention');
		expect(row.rows[0].payload.source).toBe('mention');
		expect(row.rows[0].payload.comment_id).toBe('first-mention');
	});

	it('does not coalesce non-issue wakeups beyond the 2s window', async () => {
		await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agentId]);

		const id1 = await createWakeup(db, agentId, companyId, 'heartbeat', {});

		await db.query(
			"UPDATE agent_wakeup_requests SET created_at = now() - interval '10 seconds' WHERE id = $1",
			[id1],
		);

		const id2 = await createWakeup(db, agentId, companyId, 'heartbeat', {});

		expect(id2).not.toBe(id1);
	});

	it('respects idempotency keys', async () => {
		const id1 = await createWakeup(db, agentId, companyId, 'timer', {}, 'unique-key-1');
		const id2 = await createWakeup(db, agentId, companyId, 'timer', {}, 'unique-key-1');
		expect(id2).toBe(id1);
	});

	it('creates wakeup on issue reassignment via PATCH', async () => {
		const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Wakeup Project', description: 'Test project.' }),
		});
		const projectId = (await projectRes.json()).data.id;

		// Create a second agent to reassign to
		const agent2Res = await app.request(`/api/companies/${companyId}/agents`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Reassign Target' }),
		});
		const agent2Id = (await agent2Res.json()).data.id;

		const issueRes = await app.request(`/api/companies/${companyId}/issues`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ project_id: projectId, title: 'Wakeup Issue', assignee_id: agentId }),
		});
		const issueId = (await issueRes.json()).data.id;

		await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agent2Id]);

		await app.request(`/api/companies/${companyId}/issues/${issueId}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ assignee_id: agent2Id }),
		});

		await new Promise((r) => setTimeout(r, 50));

		const wakeups = await db.query(
			"SELECT * FROM agent_wakeup_requests WHERE member_id = $1 AND source = 'assignment'",
			[agent2Id],
		);
		expect(wakeups.rows.length).toBeGreaterThanOrEqual(1);
	});

	it('creates wakeup on issue creation with agent assignee', async () => {
		const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Create Wakeup Project', description: 'Test project.' }),
		});
		const projectId = (await projectRes.json()).data.id;

		await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agentId]);

		const issueRes = await app.request(`/api/companies/${companyId}/issues`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Issue with agent assignee',
				assignee_id: agentId,
			}),
		});
		expect(issueRes.status).toBe(201);

		await new Promise((r) => setTimeout(r, 50));

		const wakeups = await db.query(
			"SELECT * FROM agent_wakeup_requests WHERE member_id = $1 AND source = 'assignment'",
			[agentId],
		);
		expect(wakeups.rows.length).toBeGreaterThanOrEqual(1);
	});

	it('rejects issue creation without assignee', async () => {
		const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'No Wakeup Project', description: 'Test project.' }),
		});
		const projectId = (await projectRes.json()).data.id;

		const issueRes = await app.request(`/api/companies/${companyId}/issues`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Issue without assignee',
			}),
		});
		expect(issueRes.status).toBe(400);
	});

	it('creates wakeup on sub-issue creation with agent assignee', async () => {
		const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Sub-issue Wakeup Project', description: 'Test project.' }),
		});
		const projectId = (await projectRes.json()).data.id;

		const parentRes = await app.request(`/api/companies/${companyId}/issues`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ project_id: projectId, title: 'Parent issue', assignee_id: agentId }),
		});
		const parentId = (await parentRes.json()).data.id;

		await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agentId]);

		const subRes = await app.request(`/api/companies/${companyId}/issues/${parentId}/sub-issues`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				title: 'Sub-issue with agent',
				assignee_id: agentId,
			}),
		});
		expect(subRes.status).toBe(201);

		await new Promise((r) => setTimeout(r, 50));

		const wakeups = await db.query(
			"SELECT * FROM agent_wakeup_requests WHERE member_id = $1 AND source = 'assignment'",
			[agentId],
		);
		expect(wakeups.rows.length).toBeGreaterThanOrEqual(1);
	});
});
