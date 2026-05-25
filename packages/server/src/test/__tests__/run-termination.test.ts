import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../lib/types';
import { safeClose } from '../helpers';
import { authHeader, createTestApp, createTestProject } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let teamId: string;
let agentId: string;
let projectId: string;
let taskId: string;

async function makeWakeup(): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload, claimed_at)
		 VALUES ($1, $2, 'on_demand'::wakeup_source, 'claimed'::wakeup_status, '{}'::jsonb, now())
		 RETURNING id`,
		[agentId, teamId],
	);
	return r.rows[0].id;
}

async function makeRun(status: 'queued' | 'running' | 'succeeded'): Promise<string> {
	const wakeupId = await makeWakeup();
	const r = await db.query<{ id: string }>(
		`INSERT INTO heartbeat_runs (member_id, team_id, task_id, wakeup_id, status, started_at)
		 VALUES ($1, $2, $3, $4, $5::heartbeat_run_status, now())
		 RETURNING id`,
		[agentId, teamId, taskId, wakeupId, status],
	);
	return r.rows[0].id;
}

async function getRunRow(runId: string): Promise<{ status: string; error: string | null }> {
	const r = await db.query<{ status: string; error: string | null }>(
		'SELECT status, error FROM heartbeat_runs WHERE id = $1',
		[runId],
	);
	return r.rows[0];
}

interface SysCommentRow {
	content: { kind?: string; reason?: string; run_id?: string };
}

async function getSystemComments(forTaskId: string): Promise<SysCommentRow[]> {
	const r = await db.query<SysCommentRow>(
		"SELECT content FROM task_comments WHERE task_id = $1 AND content_type = 'system' ORDER BY created_at ASC",
		[forTaskId],
	);
	return r.rows;
}

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 5_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const result = await fn();
		if (result != null) return result;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error('Timed out waiting for condition');
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const teamRes = await app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Terminate Test Co' }),
	});
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Main',
		description: 'Test project.',
	});
	projectId = (await projectRes.json()).data.id;

	const agentRes = await app.request(`/api/teams/${teamId}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Test Runner' }),
	});
	agentId = (await agentRes.json()).data.id;

	const taskRes = await app.request(`/api/teams/${teamId}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			project_id: projectId,
			title: 'Test Task',
			assignee_id: agentId,
		}),
	});
	taskId = (await taskRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('POST /heartbeat-runs/:runId/terminate', () => {
	it('cancels a queued run and posts a system comment', async () => {
		const runId = await makeRun('queued');

		const res = await app.request(
			`/api/teams/${teamId}/agents/${agentId}/heartbeat-runs/${runId}/terminate`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: '{}',
			},
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.terminated).toBe(true);

		const row = await getRunRow(runId);
		expect(row.status).toBe('cancelled');
		expect(row.error).toBe('Terminated by user');

		const sysComments = await getSystemComments(taskId);
		const terminationComment = sysComments.find(
			(c) => c.content?.kind === 'run_terminated' && c.content?.run_id === runId,
		);
		expect(terminationComment).toBeTruthy();
		expect(terminationComment?.content?.reason).toBe('Terminated by user');
	});

	it('returns 409 when the run is already terminal', async () => {
		const runId = await makeRun('queued');
		await db.query(
			"UPDATE heartbeat_runs SET status = 'succeeded'::heartbeat_run_status, finished_at = now() WHERE id = $1",
			[runId],
		);

		const res = await app.request(
			`/api/teams/${teamId}/agents/${agentId}/heartbeat-runs/${runId}/terminate`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: '{}',
			},
		);
		expect(res.status).toBe(409);
	});

	it('returns 404 for an unknown run id', async () => {
		const fakeId = '00000000-0000-0000-0000-000000000000';
		const res = await app.request(
			`/api/teams/${teamId}/agents/${agentId}/heartbeat-runs/${fakeId}/terminate`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: '{}',
			},
		);
		expect(res.status).toBe(404);
	});
});

describe('PATCH /tasks status → Closed/Cancelled', () => {
	it('auto-terminates queued runs when task closes', async () => {
		const runId = await makeRun('queued');

		const res = await app.request(`/api/teams/${teamId}/tasks/${taskId}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'closed' }),
		});
		expect(res.status).toBe(200);

		await waitFor(async () => {
			const row = await getRunRow(runId);
			return row.status === 'cancelled' ? row : null;
		});

		const row = await getRunRow(runId);
		expect(row.status).toBe('cancelled');
		expect(row.error).toBe('Task closed');

		const sysComments = await getSystemComments(taskId);
		const terminationComment = sysComments.find(
			(c) => c.content?.kind === 'run_terminated' && c.content?.run_id === runId,
		);
		expect(terminationComment).toBeTruthy();
	});

	it('auto-terminates queued runs when task is cancelled', async () => {
		await db.query("UPDATE tasks SET status = 'backlog'::task_status WHERE id = $1", [taskId]);
		const runId = await makeRun('queued');

		const res = await app.request(`/api/teams/${teamId}/tasks/${taskId}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'cancelled' }),
		});
		expect(res.status).toBe(200);

		await waitFor(async () => {
			const row = await getRunRow(runId);
			return row.status === 'cancelled' ? row : null;
		});

		const row = await getRunRow(runId);
		expect(row.status).toBe('cancelled');
		expect(row.error).toBe('Task cancelled');
	});
});
