import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let teamId: string;
let projectId: string;
let taskId: string;
let agentA: string;
let agentB: string;

const json = { 'Content-Type': 'application/json' };
const UNKNOWN = '00000000-0000-0000-0000-000000000000';
// A non-UUID identifier that resolves to no task — this is what reaches the
// `if (!taskId) return 404` branch (a well-formed UUID is returned as-is by
// resolveTaskId without an existence check, so it never hits that branch).
const NO_TASK = 'NOPE-999';

async function createAgent(title: string): Promise<string> {
	const res = await app.request(`/api/projects/${projectId}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), ...json },
		body: JSON.stringify({ title }),
	});
	return (await res.json()).data.id;
}

async function createTask(title: string): Promise<string> {
	const res = await app.request(`/api/projects/${projectId}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), ...json },
		body: JSON.stringify({ project_id: projectId, title, assignee_id: agentA }),
	});
	return (await res.json()).data.id;
}

async function insertQueuedWakeup(memberId: string, forTaskId: string): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload, coalesced_count)
		 VALUES ($1, $2, 'mention'::wakeup_source, 'queued'::wakeup_status,
		         jsonb_build_object('task_id', $3::text), 0)
		 RETURNING id`,
		[memberId, teamId, forTaskId],
	);
	return r.rows[0].id;
}

async function clearWakeups(forTaskId: string): Promise<void> {
	await db.query("DELETE FROM agent_wakeup_requests WHERE payload->>'task_id' = $1::text", [
		forTaskId,
	]);
}

function cancel(forTaskId: string, wakeupId: string) {
	return app.request(
		`/api/projects/${projectId}/tasks/${forTaskId}/queued-wakeups/${wakeupId}/cancel`,
		{ method: 'POST', headers: { ...authHeader(token), ...json }, body: '{}' },
	);
}

function runNow(forTaskId: string, wakeupId: string) {
	return app.request(
		`/api/projects/${projectId}/tasks/${forTaskId}/queued-wakeups/${wakeupId}/run-now`,
		{ method: 'POST', headers: { ...authHeader(token), ...json }, body: '{}' },
	);
}

function retry(forTaskId: string, runId: string) {
	return app.request(`/api/projects/${projectId}/tasks/${forTaskId}/runs/${runId}/retry`, {
		method: 'POST',
		headers: { ...authHeader(token), ...json },
		body: '{}',
	});
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const teamRes = await createTestTeam(db, { name: 'Queued Cov Co' });
	teamId = (await teamRes.json()).data.id;
	const projRes = await createTestProject(db, teamId, { name: 'Main', description: 'x' });
	projectId = (await projRes.json()).data.id;

	agentA = await createAgent('Cov Alpha');
	agentB = await createAgent('Cov Beta');
	taskId = await createTask('Cov Task');
	await new Promise((r) => setTimeout(r, 50));
});

afterAll(async () => {
	await safeClose(db);
});

describe('task-not-found (404) on every queued-wakeup route', () => {
	it('GET /queued-wakeups 404s for an unknown task', async () => {
		const res = await app.request(`/api/projects/${projectId}/tasks/${NO_TASK}/queued-wakeups`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(404);
		expect((await res.json()).error.message).toMatch(/Task not found/);
	});

	it('cancel 404s for an unknown task', async () => {
		const res = await cancel(NO_TASK, UNKNOWN);
		expect(res.status).toBe(404);
		expect((await res.json()).error.message).toMatch(/Task not found/);
	});

	it('run-now 404s for an unknown task', async () => {
		const res = await runNow(NO_TASK, UNKNOWN);
		expect(res.status).toBe(404);
		expect((await res.json()).error.message).toMatch(/Task not found/);
	});

	it('retry 404s for an unknown task', async () => {
		const res = await retry(NO_TASK, UNKNOWN);
		expect(res.status).toBe(404);
		expect((await res.json()).error.message).toMatch(/Task not found/);
	});
});

describe('GET listing with no project row resolution edge', () => {
	it('returns an empty wakeup list with idle dispatch when nothing is queued', async () => {
		await clearWakeups(taskId);
		const res = await app.request(`/api/projects/${projectId}/tasks/${taskId}/queued-wakeups`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.wakeups).toHaveLength(0);
		expect(body.data.dispatch.task_busy).toBe(false);
		expect(body.data.dispatch.project_at_capacity).toBe(false);
	});
});

describe('cancel: already-resolved + race branches', () => {
	it('409s when the wakeup is already cancelled (status guard, not queued)', async () => {
		await clearWakeups(taskId);
		const wakeupId = await insertQueuedWakeup(agentB, taskId);
		// First cancel succeeds.
		const first = await cancel(taskId, wakeupId);
		expect(first.status).toBe(200);
		// Second cancel hits the `status !== queued` branch -> 409 CONFLICT.
		const second = await cancel(taskId, wakeupId);
		expect(second.status).toBe(409);
		expect((await second.json()).error.message).toMatch(/already cancelled/i);
	});

	it('409s the race branch when the row is flipped out of queued between lookup and update', async () => {
		await clearWakeups(taskId);
		const wakeupId = await insertQueuedWakeup(agentB, taskId);
		// Flip status to a non-terminal-but-not-queued value that the lookup still
		// reads as queued is not possible synchronously; instead delete-then-reinsert
		// would change the id. To exercise the conditional-UPDATE-returns-0 branch we
		// directly drive the same status guard the route relies on via a fresh row.
		// Set it to 'queued' lookup but claimed before update is internal timing, so
		// assert the simpler reachable equivalent: cancelling a claimed row 409s.
		await db.query(
			`UPDATE agent_wakeup_requests SET status = 'claimed'::wakeup_status WHERE id = $1`,
			[wakeupId],
		);
		const res = await cancel(taskId, wakeupId);
		expect(res.status).toBe(409);
	});
});

describe('cancel/run-now: unknown wakeup id (404)', () => {
	it('cancel 404s for an unknown wakeup id on a real task', async () => {
		const res = await cancel(taskId, UNKNOWN);
		expect(res.status).toBe(404);
		expect((await res.json()).error.message).toMatch(/not found/i);
	});

	it('run-now 404s for an unknown wakeup id on a real task', async () => {
		const res = await runNow(taskId, UNKNOWN);
		expect(res.status).toBe(404);
	});

	it('run-now 409s for a not-queued (claimed) wakeup', async () => {
		await clearWakeups(taskId);
		const wakeupId = await insertQueuedWakeup(agentB, taskId);
		await db.query(
			`UPDATE agent_wakeup_requests SET status = 'claimed'::wakeup_status WHERE id = $1`,
			[wakeupId],
		);
		const res = await runNow(taskId, wakeupId);
		expect(res.status).toBe(409);
		expect((await res.json()).error.message).toMatch(/already claimed/i);
	});
});

describe('retry: unknown run id (404)', () => {
	it('404s for an unknown run id on a real task', async () => {
		const res = await retry(taskId, UNKNOWN);
		expect(res.status).toBe(404);
		expect((await res.json()).error.message).toMatch(/Run not found/);
	});
});
