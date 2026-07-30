import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import { waitForBackground } from '../src/lib/background';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	projectSlugFor,
} from './helpers/app';
import {
	clearMaxActiveContainersForTest,
	removeSeededContainerProject,
	seedRunningContainerProject,
	setMaxActiveContainersForTest,
} from './helpers/capacity';

let app: Hono<Env>;
let db: Db;
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
	opts: { status?: string; coalesced?: number; source?: string; skipped?: string } = {},
): Promise<string> {
	const {
		status = 'queued',
		coalesced = 0,
		source = 'mention',
		skipped = null,
	} = opts as {
		status?: string;
		coalesced?: number;
		source?: string;
		skipped?: string | null;
	};
	const r = await db.query<{ id: string }>(
		`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload, coalesced_count, last_skipped_reason)
		 VALUES ($1, $2, $3::wakeup_source, $4::wakeup_status,
		         jsonb_build_object('task_id', $5::text), $6, $7)
		 RETURNING id`,
		[memberId, teamId, source, status, forTaskId, coalesced, skipped],
	);
	return r.rows[0].id;
}

async function createAgent(title: string): Promise<string> {
	const res = await app.request(`/api/projects/${await projectSlugFor(db, teamId)}/agents`, {
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

async function clearWakeups(forTaskId: string): Promise<void> {
	await db.query("DELETE FROM agent_wakeup_requests WHERE payload->>'task_id' = $1::text", [
		forTaskId,
	]);
}

afterEach(async () => {
	// Same drain as queued-wakeups.test.ts: dispatched tests now launch real
	// background runs (lazy-start); settle them and sweep their leftovers so
	// later assertions see only their own rows.
	await waitForBackground();
	await db.query(
		`DELETE FROM agent_wakeup_requests WHERE team_id = $1 AND status = 'queued'::wakeup_status`,
		[teamId],
	);
	await db.query('UPDATE execution_locks SET released_at = now() WHERE released_at IS NULL');
	await clearRuns();
});

async function insertRunningRun(memberId: string, forTaskId: string): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at)
		 VALUES ($1, $2, $3, 'running'::heartbeat_run_status, now())
		 RETURNING id`,
		[memberId, teamId, forTaskId],
	);
	return r.rows[0].id;
}

async function insertFailedRun(memberId: string, forTaskId: string): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at, finished_at, error)
		 VALUES ($1, $2, $3, 'failed'::heartbeat_run_status, now(), now(), 'boom')
		 RETURNING id`,
		[memberId, teamId, forTaskId],
	);
	return r.rows[0].id;
}

async function clearRuns(): Promise<void> {
	await db.query('DELETE FROM heartbeat_runs WHERE team_id = $1', [teamId]);
}

async function listQueued(forTaskId: string) {
	const res = await app.request(`/api/projects/${projectId}/tasks/${forTaskId}/queued-wakeups`, {
		headers: authHeader(token),
	});
	return {
		status: res.status,
		body: (await res.json()) as {
			data: {
				wakeups: Array<{
					id: string;
					member_id: string;
					member_name: string;
					source: string;
					coalesced_count: number;
					last_skipped_reason: string | null;
					agent_busy: boolean;
					run_now_blocked: string | null;
				}>;
				dispatch: { task_busy: boolean; instance_at_capacity: boolean };
			};
		},
	};
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

	const teamRes = await createTestTeam(db, { name: 'Wakeup Covfill Co' });
	teamId = (await teamRes.json()).data.id;
	const projectRes = await createTestProject(db, teamId, { name: 'Wakeup Covfill Project' });
	projectId = (await projectRes.json()).data.id;

	agentA = await createAgent('Covfill Alpha');
	agentB = await createAgent('Covfill Beta');
	taskId = await createTask('Covfill Task');
	// Let the fire-and-forget assignment wakeup land before tests clear it.
	await new Promise((r) => setTimeout(r, 50));
});

afterAll(async () => {
	await safeClose(db);
});

describe('GET queued-wakeups', () => {
	it('404s when the task does not exist', async () => {
		const { status } = await listQueued('nope-999');
		expect(status).toBe(404);
	});

	it('lists queued wakeups with names, sources, and skip reasons', async () => {
		await clearWakeups(taskId);
		await clearRuns();
		const wA = await insertQueuedWakeup(agentA, taskId, {
			source: 'assignment',
			skipped: 'task_busy',
		});
		const wB = await insertQueuedWakeup(agentB, taskId, { coalesced: 3 });
		await insertQueuedWakeup(agentA, taskId, { status: 'claimed' });

		const { status, body } = await listQueued(taskId);
		expect(status).toBe(200);
		const { wakeups, dispatch } = body.data;
		expect(wakeups.map((w) => w.id)).toEqual([wA, wB]);
		const alpha = wakeups[0];
		expect(alpha.member_name).toBe('Covfill Alpha');
		expect(alpha.source).toBe('assignment');
		expect(alpha.last_skipped_reason).toBe('task_busy');
		expect(wakeups[1].coalesced_count).toBe(3);
		expect(dispatch.task_busy).toBe(false);
		expect(dispatch.instance_at_capacity).toBe(false);
		expect(alpha.agent_busy).toBe(false);
		expect(alpha.run_now_blocked).toBeNull();
	});

	it('reports task_busy when the task has a running run', async () => {
		await clearWakeups(taskId);
		await clearRuns();
		await insertRunningRun(agentA, taskId);
		await insertQueuedWakeup(agentB, taskId);

		const { body } = await listQueued(taskId);
		expect(body.data.dispatch.task_busy).toBe(true);
		expect(body.data.dispatch.instance_at_capacity).toBe(false);
		await clearRuns();
	});

	it('reports instance_at_capacity and per-agent busy state', async () => {
		await clearWakeups(taskId);
		await clearRuns();
		// Container semantics: this project's container is stopped and a filler
		// project's running container consumes the single slot. Per-agent busy
		// state is independent of the container gate.
		await setMaxActiveContainersForTest(db, 1);
		await db.query(`UPDATE projects SET container_status = 'stopped' WHERE id = $1`, [projectId]);
		await seedRunningContainerProject(db, 'cap-covfill-get');
		const sibling = await createTask('Covfill Busy Sibling');
		await insertRunningRun(agentA, sibling);
		const busy = await insertQueuedWakeup(agentA, taskId);
		const free = await insertQueuedWakeup(agentB, taskId);

		const { body } = await listQueued(taskId);
		expect(body.data.dispatch.task_busy).toBe(false);
		expect(body.data.dispatch.instance_at_capacity).toBe(true);
		const byId = Object.fromEntries(body.data.wakeups.map((w) => [w.id, w]));
		expect(byId[busy].agent_busy).toBe(true);
		expect(byId[free].agent_busy).toBe(false);

		await db.query(`UPDATE projects SET container_status = 'running' WHERE id = $1`, [projectId]);
		await removeSeededContainerProject(db, 'cap-covfill-get');
		await clearMaxActiveContainersForTest(db);
		await clearRuns();
	});

	it('flags run_now_blocked for dependency-gated sources', async () => {
		await clearWakeups(taskId);
		await clearRuns();
		const blocker = await createTask('Covfill Blocker');
		await db.query('INSERT INTO task_dependencies (task_id, blocked_by_task_id) VALUES ($1, $2)', [
			taskId,
			blocker,
		]);
		const gated = await insertQueuedWakeup(agentA, taskId, { source: 'assignment' });
		const ungated = await insertQueuedWakeup(agentB, taskId, { source: 'mention' });

		const { body } = await listQueued(taskId);
		const byId = Object.fromEntries(body.data.wakeups.map((w) => [w.id, w]));
		expect(byId[gated].run_now_blocked).toBe('blocked_by_dependency');
		expect(byId[ungated].run_now_blocked).toBeNull();
		await db.query('DELETE FROM task_dependencies WHERE task_id = $1', [taskId]);
	});
});

describe('POST cancel', () => {
	it('404s for a task that does not exist', async () => {
		const res = await cancel('nope-999', '00000000-0000-0000-0000-000000000000');
		expect(res.status).toBe(404);
	});

	it('404s for an unknown wakeup and one on a different task', async () => {
		const unknown = await cancel(taskId, '00000000-0000-0000-0000-000000000000');
		expect(unknown.status).toBe(404);

		const otherTask = await createTask('Covfill Cancel Other');
		const foreign = await insertQueuedWakeup(agentB, otherTask);
		const res = await cancel(taskId, foreign);
		expect(res.status).toBe(404);
		const row = await db.query<{ status: string }>(
			'SELECT status FROM agent_wakeup_requests WHERE id = $1',
			[foreign],
		);
		expect(row.rows[0].status).toBe('queued');
	});

	it('409s when the wakeup is no longer queued', async () => {
		const claimed = await insertQueuedWakeup(agentB, taskId, { status: 'claimed' });
		const res = await cancel(taskId, claimed);
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: { message: string } };
		expect(body.error.message).toContain('claimed');
	});

	it('cancels a queued wakeup and records a system comment', async () => {
		await clearWakeups(taskId);
		const wakeupId = await insertQueuedWakeup(agentB, taskId);

		const res = await cancel(taskId, wakeupId);
		expect(res.status).toBe(200);
		expect((await res.json()).data.cancelled).toBe(true);

		const row = await db.query<{ status: string; completed_at: string | null }>(
			'SELECT status, completed_at FROM agent_wakeup_requests WHERE id = $1',
			[wakeupId],
		);
		expect(row.rows[0].status).toBe('cancelled');
		expect(row.rows[0].completed_at).not.toBeNull();

		const sys = await db.query<{ content: { kind?: string; wakeup_id?: string } }>(
			"SELECT content FROM task_comments WHERE task_id = $1 AND content_type = 'system'",
			[taskId],
		);
		expect(
			sys.rows.some(
				(s) => s.content?.kind === 'wakeup_cancelled' && s.content?.wakeup_id === wakeupId,
			),
		).toBe(true);
	});
});

describe('POST run-now', () => {
	it('404s for unknown task, unknown wakeup, and a wakeup on another task', async () => {
		expect((await runNow('nope-999', '00000000-0000-0000-0000-000000000000')).status).toBe(404);
		expect((await runNow(taskId, '00000000-0000-0000-0000-000000000000')).status).toBe(404);

		const otherTask = await createTask('Covfill RunNow Other');
		const foreign = await insertQueuedWakeup(agentB, otherTask);
		expect((await runNow(taskId, foreign)).status).toBe(404);
	});

	it('409s when the wakeup is not queued', async () => {
		const claimed = await insertQueuedWakeup(agentB, taskId, { status: 'claimed' });
		const res = await runNow(taskId, claimed);
		expect(res.status).toBe(409);
	});

	it('409s with a task-busy message when the task already runs', async () => {
		await clearWakeups(taskId);
		await clearRuns();
		await insertRunningRun(agentA, taskId);
		const wakeupId = await insertQueuedWakeup(agentB, taskId);

		const res = await runNow(taskId, wakeupId);
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: { message: string } };
		expect(body.error.message).toContain('already has a run in progress');
		const row = await db.query<{ status: string; last_skipped_reason: string | null }>(
			'SELECT status, last_skipped_reason FROM agent_wakeup_requests WHERE id = $1',
			[wakeupId],
		);
		expect(row.rows[0].status).toBe('queued');
		expect(row.rows[0].last_skipped_reason).toBe('task_busy');
		await clearRuns();
	});

	it('409s when the container limit is reached', async () => {
		await clearWakeups(taskId);
		await clearRuns();
		await setMaxActiveContainersForTest(db, 1);
		await db.query(`UPDATE projects SET container_status = 'stopped' WHERE id = $1`, [projectId]);
		await seedRunningContainerProject(db, 'cap-covfill-runnow');
		const wakeupId = await insertQueuedWakeup(agentB, taskId);

		const res = await runNow(taskId, wakeupId);
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: { message: string } };
		expect(body.error.message).toContain('active-container limit');
		await db.query(`UPDATE projects SET container_status = 'running' WHERE id = $1`, [projectId]);
		await removeSeededContainerProject(db, 'cap-covfill-runnow');
		await clearMaxActiveContainersForTest(db);
		await clearRuns();
	});

	it('409s when the wakeup source is gated by an open dependency', async () => {
		await clearWakeups(taskId);
		await clearRuns();
		const blocker = await createTask('Covfill RunNow Blocker');
		await db.query('INSERT INTO task_dependencies (task_id, blocked_by_task_id) VALUES ($1, $2)', [
			taskId,
			blocker,
		]);
		const wakeupId = await insertQueuedWakeup(agentB, taskId, { source: 'assignment' });

		const res = await runNow(taskId, wakeupId);
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: { message: string } };
		expect(body.error.message).toMatch(/dependency/i);
		await db.query('DELETE FROM task_dependencies WHERE task_id = $1', [taskId]);
	});

	it('stamps the actor on the payload and dispatches', async () => {
		await clearWakeups(taskId);
		await clearRuns();
		const wakeupId = await insertQueuedWakeup(agentB, taskId);

		const res = await runNow(taskId, wakeupId);
		expect(res.status).toBe(200);
		expect((await res.json()).data.dispatched).toBe(true);

		const row = await db.query<{
			status: string;
			payload: { triggered_by?: { name: string } };
		}>('SELECT status, payload FROM agent_wakeup_requests WHERE id = $1', [wakeupId]);
		expect(row.rows[0].status).not.toBe('queued');
		expect(row.rows[0].payload.triggered_by?.name).toBe('Test Admin');
	});
});

describe('POST runs/:runId/retry', () => {
	it('404s for unknown task, unknown run, and a run on another task', async () => {
		expect((await retry('nope-999', '00000000-0000-0000-0000-000000000000')).status).toBe(404);
		expect((await retry(taskId, '00000000-0000-0000-0000-000000000000')).status).toBe(404);

		await clearRuns();
		const otherTask = await createTask('Covfill Retry Other');
		const foreignRun = await insertFailedRun(agentB, otherTask);
		expect((await retry(taskId, foreignRun)).status).toBe(404);
		await clearRuns();
	});

	it('409s when the task already has a run in progress', async () => {
		await clearWakeups(taskId);
		await clearRuns();
		await insertRunningRun(agentA, taskId);
		const failed = await insertFailedRun(agentB, taskId);

		const res = await retry(taskId, failed);
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: { message: string } };
		expect(body.error.message).toContain('already has a run in progress');
		await clearRuns();
	});

	it("creates an on_demand wakeup for the failed run's agent and dispatches it", async () => {
		await clearWakeups(taskId);
		await clearRuns();
		const runId = await insertFailedRun(agentB, taskId);

		const res = await retry(taskId, runId);
		expect(res.status).toBe(200);
		expect((await res.json()).data.dispatched).toBe(true);

		// The dispatch launches a background run (lazy-start); settle it so its
		// failure-chain wakeups can't race the assertions, then pin them to the
		// retry's own on_demand wakeup.
		await waitForBackground();
		const wakeup = await db.query<{
			member_id: string;
			source: string;
			status: string;
			payload: { source_run_id?: string; triggered_by?: { name: string } };
		}>(
			`SELECT member_id, source, status, payload FROM agent_wakeup_requests
			 WHERE payload->>'task_id' = $1 AND source = 'on_demand'`,
			[taskId],
		);
		expect(wakeup.rows).toHaveLength(1);
		expect(wakeup.rows[0].member_id).toBe(agentB);
		expect(wakeup.rows[0].source).toBe('on_demand');
		expect(wakeup.rows[0].status).not.toBe('queued');
		expect(wakeup.rows[0].payload.source_run_id).toBe(runId);
		expect(wakeup.rows[0].payload.triggered_by?.name).toBe('Test Admin');
	});
});
