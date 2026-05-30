import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject } from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let teamId: string;
let projectId: string;
let taskId: string;
let agentA: string;
let agentB: string;

const json = { 'Content-Type': 'application/json' };

async function insertQueuedWakeup(
	memberId: string,
	forTaskId: string,
	opts: { status?: string; coalesced?: number; source?: string } = {},
): Promise<string> {
	const { status = 'queued', coalesced = 0, source = 'mention' } = opts;
	const r = await db.query<{ id: string }>(
		`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload, coalesced_count)
		 VALUES ($1, $2, $3::wakeup_source, $4::wakeup_status,
		         jsonb_build_object('task_id', $5::text), $6)
		 RETURNING id`,
		[memberId, teamId, source, status, forTaskId, coalesced],
	);
	return r.rows[0].id;
}

async function createAgent(title: string): Promise<string> {
	const res = await app.request(`/api/teams/${teamId}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), ...json },
		body: JSON.stringify({ title }),
	});
	return (await res.json()).data.id;
}

async function createTask(title: string): Promise<string> {
	const res = await app.request(`/api/teams/${teamId}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), ...json },
		// assignee is required; agentA owns the task. The auto 'assignment' wakeup
		// it spawns is cleared per-test via clearWakeups so the list is controlled.
		body: JSON.stringify({ project_id: projectId, title, assignee_id: agentA }),
	});
	return (await res.json()).data.id;
}

async function clearWakeups(forTaskId: string): Promise<void> {
	await db.query("DELETE FROM agent_wakeup_requests WHERE payload->>'task_id' = $1::text", [
		forTaskId,
	]);
}

async function listQueued(forTaskId: string) {
	const res = await app.request(`/api/teams/${teamId}/tasks/${forTaskId}/queued-wakeups`, {
		headers: authHeader(token),
	});
	return { status: res.status, body: (await res.json()) as { data: { wakeups: WakeupRow[] } } };
}

interface WakeupRow {
	id: string;
	member_id: string;
	member_name: string;
	source: string;
	created_at: string;
	coalesced_count: number;
	last_skipped_reason: string | null;
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const teamRes = await app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(token), ...json },
		body: JSON.stringify({ name: 'Queued Wakeups Co' }),
	});
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Main',
		description: 'Test project.',
	});
	projectId = (await projectRes.json()).data.id;

	agentA = await createAgent('Agent Alpha');
	agentB = await createAgent('Agent Beta');
	taskId = await createTask('Queued Task');
	// Let the fire-and-forget assignment wakeup land, then start each test from a
	// clean slate via clearWakeups.
	await new Promise((r) => setTimeout(r, 50));
});

afterAll(async () => {
	await safeClose(db);
});

describe('GET /teams/:teamId/tasks/:taskId/queued-wakeups', () => {
	it('lists queued wakeups with member name, excluding non-queued ones', async () => {
		await clearWakeups(taskId);
		const wA = await insertQueuedWakeup(agentA, taskId, { source: 'assignment' });
		const wB = await insertQueuedWakeup(agentB, taskId, { coalesced: 2 });
		// A claimed wakeup (the running agent) must be excluded.
		await insertQueuedWakeup(agentA, taskId, { status: 'claimed' });

		const { status, body } = await listQueued(taskId);
		expect(status).toBe(200);
		const { wakeups } = body.data;
		const ids = wakeups.map((w) => w.id);
		expect(ids).toContain(wA);
		expect(ids).toContain(wB);
		expect(wakeups.length).toBe(2);

		const beta = wakeups.find((w) => w.id === wB);
		expect(beta?.member_name).toBe('Agent Beta');
		expect(beta?.source).toBe('mention');
		expect(beta?.coalesced_count).toBe(2);

		// Ordered by created_at ASC — A was inserted first.
		expect(wakeups[0].id).toBe(wA);
	});
});

describe('POST /teams/:teamId/tasks/:taskId/queued-wakeups/:wakeupId/cancel', () => {
	it('cancels a queued wakeup and posts a system comment', async () => {
		await clearWakeups(taskId);
		const wakeupId = await insertQueuedWakeup(agentB, taskId);

		const res = await app.request(
			`/api/teams/${teamId}/tasks/${taskId}/queued-wakeups/${wakeupId}/cancel`,
			{ method: 'POST', headers: { ...authHeader(token), ...json }, body: '{}' },
		);
		expect(res.status).toBe(200);
		expect((await res.json()).data.cancelled).toBe(true);

		const row = await db.query<{ status: string; completed_at: string | null }>(
			'SELECT status, completed_at FROM agent_wakeup_requests WHERE id = $1',
			[wakeupId],
		);
		expect(row.rows[0].status).toBe('cancelled');
		expect(row.rows[0].completed_at).not.toBeNull();

		const sys = await db.query<{ content: { kind?: string; wakeup_id?: string } }>(
			"SELECT content FROM task_comments WHERE task_id = $1 AND content_type = 'system' ORDER BY created_at DESC",
			[taskId],
		);
		const cancelComment = sys.rows.find(
			(s) => s.content?.kind === 'wakeup_cancelled' && s.content?.wakeup_id === wakeupId,
		);
		expect(cancelComment).toBeTruthy();

		// No longer listed.
		const { body } = await listQueued(taskId);
		expect(body.data.wakeups.map((w) => w.id)).not.toContain(wakeupId);
	});

	it('returns 409 when the wakeup is not queued', async () => {
		const wakeupId = await insertQueuedWakeup(agentB, taskId, { status: 'claimed' });
		const res = await app.request(
			`/api/teams/${teamId}/tasks/${taskId}/queued-wakeups/${wakeupId}/cancel`,
			{ method: 'POST', headers: { ...authHeader(token), ...json }, body: '{}' },
		);
		expect(res.status).toBe(409);
	});

	it('returns 404 for an unknown wakeup id', async () => {
		const res = await app.request(
			`/api/teams/${teamId}/tasks/${taskId}/queued-wakeups/00000000-0000-0000-0000-000000000000/cancel`,
			{ method: 'POST', headers: { ...authHeader(token), ...json }, body: '{}' },
		);
		expect(res.status).toBe(404);
	});

	it('returns 404 when the wakeup belongs to a different task', async () => {
		const otherTask = await createTask('Other Task');
		const wakeupId = await insertQueuedWakeup(agentB, otherTask);
		// Cancel via the original task's route — wrong task, must 404.
		const res = await app.request(
			`/api/teams/${teamId}/tasks/${taskId}/queued-wakeups/${wakeupId}/cancel`,
			{ method: 'POST', headers: { ...authHeader(token), ...json }, body: '{}' },
		);
		expect(res.status).toBe(404);
		// Still queued on its real task.
		const row = await db.query<{ status: string }>(
			'SELECT status FROM agent_wakeup_requests WHERE id = $1',
			[wakeupId],
		);
		expect(row.rows[0].status).toBe('queued');
	});
});
