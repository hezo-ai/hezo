import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/lib/types';
import { createWakeup } from '../src/services/wakeup';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject } from './helpers/app';

let db: PGlite;
let app: Hono<Env>;
let token: string;
let teamId: string;
let agentId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	app = ctx.app;
	token = ctx.token;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const teamTemplateId = (await typesRes.json()).data.find((t: any) => t.name === 'Startup').id;

	const teamRes = await app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name: 'Wakeup Co',

			template_id: teamTemplateId,
		}),
	});
	teamId = (await teamRes.json()).data.id;

	const agentsRes = await app.request(`/api/teams/${teamId}/agents`, {
		headers: authHeader(token),
	});
	agentId = (await agentsRes.json()).data[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('wakeup service', () => {
	it('creates a wakeup request', async () => {
		const id = await createWakeup(db, agentId, teamId, 'assignment', {
			task_id: 'test-task',
		});
		expect(id).toBeTruthy();

		const result = await db.query('SELECT * FROM agent_wakeup_requests WHERE id = $1', [id]);
		expect(result.rows.length).toBe(1);
		expect((result.rows[0] as any).source).toBe('assignment');
		expect((result.rows[0] as any).status).toBe('queued');
	});

	it('does not coalesce wakeups targeting different tasks', async () => {
		await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agentId]);

		const id1 = await createWakeup(db, agentId, teamId, 'mention', {
			task_id: 'coalesce-task-a',
		});
		const id2 = await createWakeup(db, agentId, teamId, 'mention', {
			task_id: 'coalesce-task-b',
		});

		expect(id2).not.toBe(id1);

		const rows = await db.query<{ id: string; payload: { task_id: string } }>(
			"SELECT id, payload FROM agent_wakeup_requests WHERE member_id = $1 AND status = 'queued' ORDER BY created_at ASC",
			[agentId],
		);
		const taskIds = rows.rows.map((r) => r.payload.task_id).sort();
		expect(taskIds).toEqual(['coalesce-task-a', 'coalesce-task-b']);
	});

	it('coalesces wakeups for the same task regardless of timing', async () => {
		await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agentId]);

		const id1 = await createWakeup(db, agentId, teamId, 'mention', {
			task_id: 'same-task',
		});
		const id2 = await createWakeup(db, agentId, teamId, 'mention', {
			task_id: 'same-task',
		});

		expect(id2).toBe(id1);

		const queued = await db.query<{ coalesced_count: number }>(
			"SELECT coalesced_count FROM agent_wakeup_requests WHERE member_id = $1 AND status = 'queued' AND payload->>'task_id' = 'same-task'",
			[agentId],
		);
		expect(queued.rows.length).toBe(1);
		expect(queued.rows[0].coalesced_count).toBeGreaterThanOrEqual(1);
	});

	it('collapses repeated triggers from different sources onto one queued wakeup', async () => {
		await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agentId]);

		const id1 = await createWakeup(db, agentId, teamId, 'assignment', { task_id: 'busy-task' });
		const id2 = await createWakeup(db, agentId, teamId, 'comment', { task_id: 'busy-task' });
		const id3 = await createWakeup(db, agentId, teamId, 'mention', { task_id: 'busy-task' });

		expect(id2).toBe(id1);
		expect(id3).toBe(id1);

		const queued = await db.query(
			"SELECT id FROM agent_wakeup_requests WHERE member_id = $1 AND status = 'queued' AND payload->>'task_id' = 'busy-task'",
			[agentId],
		);
		expect(queued.rows.length).toBe(1);
	});

	it('does not coalesce onto a wakeup the dispatcher already claimed', async () => {
		await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agentId]);

		const id1 = await createWakeup(db, agentId, teamId, 'mention', { task_id: 'claim-task' });
		await db.query(
			"UPDATE agent_wakeup_requests SET status = 'claimed', claimed_at = now() WHERE id = $1",
			[id1],
		);

		const id2 = await createWakeup(db, agentId, teamId, 'mention', { task_id: 'claim-task' });
		expect(id2).not.toBe(id1);

		const claimed = await db.query<{ coalesced_count: number }>(
			'SELECT coalesced_count FROM agent_wakeup_requests WHERE id = $1',
			[id1],
		);
		expect(claimed.rows[0].coalesced_count).toBe(0);

		const queued = await db.query(
			"SELECT id FROM agent_wakeup_requests WHERE member_id = $1 AND status = 'queued' AND payload->>'task_id' = 'claim-task'",
			[agentId],
		);
		expect(queued.rows.length).toBe(1);
	});

	it('coalesces wakeups that have no task_id', async () => {
		await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agentId]);

		const id1 = await createWakeup(db, agentId, teamId, 'timer', {
			reason: 'tick-a',
		});
		const id2 = await createWakeup(db, agentId, teamId, 'timer', {
			reason: 'tick-b',
		});

		expect(id2).toBe(id1);
	});

	it('respects idempotency keys', async () => {
		const id1 = await createWakeup(db, agentId, teamId, 'timer', {}, 'unique-key-1');
		const id2 = await createWakeup(db, agentId, teamId, 'timer', {}, 'unique-key-1');
		expect(id2).toBe(id1);
	});

	it('creates wakeup on task reassignment via PATCH', async () => {
		const projectRes = await createTestProject(db, teamId, {
			name: 'Wakeup Project',
			description: 'Test project.',
		});
		const projectId = (await projectRes.json()).data.id;

		// Create a second agent to reassign to
		const agent2Res = await app.request(`/api/teams/${teamId}/agents`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Reassign Target' }),
		});
		const agent2Id = (await agent2Res.json()).data.id;

		const taskRes = await app.request(`/api/teams/${teamId}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ project_id: projectId, title: 'Wakeup Task', assignee_id: agentId }),
		});
		const taskId = (await taskRes.json()).data.id;

		await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agent2Id]);

		await app.request(`/api/teams/${teamId}/tasks/${taskId}`, {
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

	it('creates wakeup on task creation with agent assignee', async () => {
		const projectRes = await createTestProject(db, teamId, {
			name: 'Create Wakeup Project',
			description: 'Test project.',
		});
		const projectId = (await projectRes.json()).data.id;

		await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agentId]);

		const taskRes = await app.request(`/api/teams/${teamId}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Task with agent assignee',
				assignee_id: agentId,
			}),
		});
		expect(taskRes.status).toBe(201);

		await new Promise((r) => setTimeout(r, 50));

		const wakeups = await db.query(
			"SELECT * FROM agent_wakeup_requests WHERE member_id = $1 AND source = 'assignment'",
			[agentId],
		);
		expect(wakeups.rows.length).toBeGreaterThanOrEqual(1);
	});

	it('rejects task creation without assignee', async () => {
		const projectRes = await createTestProject(db, teamId, {
			name: 'No Wakeup Project',
			description: 'Test project.',
		});
		const projectId = (await projectRes.json()).data.id;

		const taskRes = await app.request(`/api/teams/${teamId}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Task without assignee',
			}),
		});
		expect(taskRes.status).toBe(400);
	});

	it('creates wakeup on sub-task creation with agent assignee', async () => {
		const projectRes = await createTestProject(db, teamId, {
			name: 'Sub-task Wakeup Project',
			description: 'Test project.',
		});
		const projectId = (await projectRes.json()).data.id;

		const parentRes = await app.request(`/api/teams/${teamId}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ project_id: projectId, title: 'Parent task', assignee_id: agentId }),
		});
		const parentId = (await parentRes.json()).data.id;

		await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agentId]);

		const subRes = await app.request(`/api/teams/${teamId}/tasks/${parentId}/sub-tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				title: 'Sub-task with agent',
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
