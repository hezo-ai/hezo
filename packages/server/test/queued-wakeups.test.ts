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
	setProjectRunLimitForTest,
} from './helpers/capacity';

let app: Hono<Env>;
let db: Db;
let token: string;
let teamId: string;
let teamSlug: string;
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

afterEach(async () => {
	// Lazy-start means the dispatch tests launch real background runs against
	// the fake docker. Drain them — and the failure-chain wakeups/locks they
	// leave — before the next test asserts on run or wakeup state; on slow CI
	// runners the async run otherwise bleeds across tests.
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

async function clearRuns(): Promise<void> {
	await db.query('DELETE FROM heartbeat_runs WHERE team_id = $1', [teamId]);
}

// Creates a fresh (backlog, i.e. non-terminal) task and links it as a blocker
// of `forTaskId`, leaving `forTaskId` with an open dependency.
async function addOpenBlocker(forTaskId: string): Promise<string> {
	const blocker = await createTask('Blocker Task');
	await db.query(
		`INSERT INTO task_dependencies (task_id, blocked_by_task_id)
		 VALUES ($1, $2) ON CONFLICT DO NOTHING`,
		[forTaskId, blocker],
	);
	return blocker;
}

async function clearBlockers(forTaskId: string): Promise<void> {
	await db.query('DELETE FROM task_dependencies WHERE task_id = $1', [forTaskId]);
}

function runNow(forTaskId: string, wakeupId: string) {
	return app.request(
		`/api/projects/${projectId}/tasks/${forTaskId}/queued-wakeups/${wakeupId}/run-now`,
		{
			method: 'POST',
			headers: { ...authHeader(token), ...json },
			body: '{}',
		},
	);
}

async function listQueued(forTaskId: string) {
	const res = await app.request(`/api/projects/${projectId}/tasks/${forTaskId}/queued-wakeups`, {
		headers: authHeader(token),
	});
	return {
		status: res.status,
		body: (await res.json()) as { data: { wakeups: WakeupRow[]; dispatch: DispatchState } },
	};
}

interface WakeupRow {
	id: string;
	member_id: string;
	member_name: string;
	source: string;
	created_at: string;
	coalesced_count: number;
	last_skipped_reason: string | null;
	agent_busy: boolean;
	run_now_blocked: 'blocked_by_dependency' | null;
}

interface DispatchState {
	task_busy: boolean;
	instance_at_capacity: boolean;
	project_at_run_limit: boolean;
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const teamRes = await createTestTeam(db, { name: 'Queued Wakeups Co' });
	const teamData = (await teamRes.json()).data;
	teamId = teamData.id;
	teamSlug = teamData.slug;

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

	it('reports an idle dispatch state when nothing is running', async () => {
		await clearWakeups(taskId);
		await clearRuns();
		await clearBlockers(taskId);
		await insertQueuedWakeup(agentB, taskId);

		const { body } = await listQueued(taskId);
		expect(body.data.dispatch.task_busy).toBe(false);
		expect(body.data.dispatch.instance_at_capacity).toBe(false);
		expect(body.data.dispatch.project_at_run_limit).toBe(false);
		expect(body.data.wakeups[0].run_now_blocked).toBeNull();
	});

	it('reports task_busy when the task already has an active run', async () => {
		await clearWakeups(taskId);
		await clearRuns();
		await insertRunningRun(agentA, taskId);
		await insertQueuedWakeup(agentB, taskId);

		const { body } = await listQueued(taskId);
		expect(body.data.dispatch.task_busy).toBe(true);
		await clearRuns();
	});

	it('reports instance_at_capacity when starting the container would exceed the limit', async () => {
		await clearWakeups(taskId);
		await clearRuns();
		// Container semantics: this project's container is stopped and a filler
		// project's running container consumes the single slot.
		await setMaxActiveContainersForTest(db, 1);
		await db.query(`UPDATE projects SET container_status = 'stopped' WHERE id = $1`, [projectId]);
		await seedRunningContainerProject(db, 'cap-filler-get');
		await insertQueuedWakeup(agentB, taskId);

		const { body } = await listQueued(taskId);
		expect(body.data.dispatch.task_busy).toBe(false);
		expect(body.data.dispatch.instance_at_capacity).toBe(true);
		await db.query(`UPDATE projects SET container_status = 'running' WHERE id = $1`, [projectId]);
		await removeSeededContainerProject(db, 'cap-filler-get');
		await clearMaxActiveContainersForTest(db);
	});

	it('reports project_at_run_limit when the project is at its own ceiling', async () => {
		await clearWakeups(taskId);
		await clearRuns();
		// A run on a different task, so task_busy does not short-circuit the chain
		// before the run-limit branch is reached.
		const otherTask = await db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title)
			 VALUES ($1, $2, 8801, 'QW-8801', 'Other') RETURNING id`,
			[teamId, projectId],
		);
		await setProjectRunLimitForTest(db, projectId, 1);
		await insertRunningRun(agentA, otherTask.rows[0].id);
		await insertQueuedWakeup(agentB, taskId);

		const { body } = await listQueued(taskId);
		expect(body.data.dispatch.task_busy).toBe(false);
		expect(body.data.dispatch.instance_at_capacity).toBe(false);
		expect(body.data.dispatch.project_at_run_limit).toBe(true);

		await setProjectRunLimitForTest(db, projectId, null);
		await clearRuns();
		await db.query('DELETE FROM tasks WHERE id = $1', [otherTask.rows[0].id]);
	});

	it('a project whose container is already running is never at capacity', async () => {
		await clearWakeups(taskId);
		await clearRuns();
		// Even with the limit fully consumed by this project's own container, a
		// run into it needs no new container slot.
		await setMaxActiveContainersForTest(db, 1);
		await insertQueuedWakeup(agentB, taskId);

		const { body } = await listQueued(taskId);
		expect(body.data.dispatch.instance_at_capacity).toBe(false);
		await clearMaxActiveContainersForTest(db);
	});

	it('flags run_now_blocked per source when the task has an open dependency', async () => {
		await clearWakeups(taskId);
		await clearRuns();
		await addOpenBlocker(taskId);
		// 'assignment' is a gated source (deferred by open blockers); 'mention' is not.
		const gated = await insertQueuedWakeup(agentA, taskId, { source: 'assignment' });
		const ungated = await insertQueuedWakeup(agentB, taskId, { source: 'mention' });

		const { body } = await listQueued(taskId);
		const byId = Object.fromEntries(body.data.wakeups.map((w) => [w.id, w]));
		expect(byId[gated].run_now_blocked).toBe('blocked_by_dependency');
		expect(byId[ungated].run_now_blocked).toBeNull();
		await clearBlockers(taskId);
	});

	it('flags agent_busy per agent when that agent runs on another task in the project', async () => {
		await clearWakeups(taskId);
		await clearRuns();
		// Agent Alpha is running on a sibling task, so its dispatch slot is taken
		// even though the project still has capacity. Agent Beta is free.
		const sibling = await createTask('Agent-busy GET Sibling');
		await insertRunningRun(agentA, sibling);
		const busy = await insertQueuedWakeup(agentA, taskId, { source: 'mention' });
		const free = await insertQueuedWakeup(agentB, taskId, { source: 'mention' });

		const { body } = await listQueued(taskId);
		const byId = Object.fromEntries(body.data.wakeups.map((w) => [w.id, w]));
		expect(byId[busy].agent_busy).toBe(true);
		expect(byId[free].agent_busy).toBe(false);
		expect(body.data.dispatch.task_busy).toBe(false);
		expect(body.data.dispatch.instance_at_capacity).toBe(false);
		await clearRuns();
	});
});

describe('POST /teams/:teamId/tasks/:taskId/queued-wakeups/:wakeupId/run-now', () => {
	it('stamps the actor on the wakeup payload and dispatches without a wakeup_started comment', async () => {
		await clearWakeups(taskId);
		await clearRuns();
		await clearBlockers(taskId);
		const wakeupId = await insertQueuedWakeup(agentB, taskId);

		const res = await runNow(taskId, wakeupId);
		expect(res.status).toBe(200);
		expect((await res.json()).data.dispatched).toBe(true);

		// The wakeup is claimed out of the queue and carries the triggering actor
		// in its payload — createHeartbeatRun reads it from there and folds it
		// into the run comment's content (no separate system comment is written).
		const row = await db.query<{
			status: string;
			payload: { triggered_by?: { member_id: string | null; name: string } };
		}>('SELECT status, payload FROM agent_wakeup_requests WHERE id = $1', [wakeupId]);
		expect(row.rows[0].status).not.toBe('queued');
		expect(row.rows[0].payload.triggered_by?.name).toBe('Test Admin');

		const sys = await db.query<{ content: { kind?: string } }>(
			"SELECT content FROM task_comments WHERE task_id = $1 AND content_type = 'system'",
			[taskId],
		);
		expect(sys.rows.some((s) => s.content?.kind === 'wakeup_started')).toBe(false);

		const { body } = await listQueued(taskId);
		expect(body.data.wakeups.map((w) => w.id)).not.toContain(wakeupId);
	});

	it('returns 409 and records task_busy when the task already has an active run', async () => {
		await clearWakeups(taskId);
		await clearRuns();
		await insertRunningRun(agentA, taskId);
		const wakeupId = await insertQueuedWakeup(agentB, taskId);

		const res = await runNow(taskId, wakeupId);
		expect(res.status).toBe(409);

		const row = await db.query<{ status: string; last_skipped_reason: string | null }>(
			'SELECT status, last_skipped_reason FROM agent_wakeup_requests WHERE id = $1',
			[wakeupId],
		);
		expect(row.rows[0].status).toBe('queued');
		expect(row.rows[0].last_skipped_reason).toBe('task_busy');
		await clearRuns();
	});

	it('returns 409 and records instance_at_capacity when the container limit is reached', async () => {
		await clearWakeups(taskId);
		await clearRuns();
		await setMaxActiveContainersForTest(db, 1);
		await db.query(`UPDATE projects SET container_status = 'stopped' WHERE id = $1`, [projectId]);
		await seedRunningContainerProject(db, 'cap-filler-runnow');
		const wakeupId = await insertQueuedWakeup(agentB, taskId);

		const res = await runNow(taskId, wakeupId);
		expect(res.status).toBe(409);

		const row = await db.query<{ status: string; last_skipped_reason: string | null }>(
			'SELECT status, last_skipped_reason FROM agent_wakeup_requests WHERE id = $1',
			[wakeupId],
		);
		expect(row.rows[0].status).toBe('queued');
		expect(row.rows[0].last_skipped_reason).toBe('instance_at_capacity');
		await db.query(`UPDATE projects SET container_status = 'running' WHERE id = $1`, [projectId]);
		await removeSeededContainerProject(db, 'cap-filler-runnow');
		await clearMaxActiveContainersForTest(db);
		await clearRuns();
	});

	it('returns 409 and leaks no lock when the agent already runs in the project', async () => {
		await clearWakeups(taskId);
		await clearRuns();
		// The same agent is already running on a sibling task in this project, so
		// its per agent+project dispatch slot is taken even though capacity remains.
		const sibling = await createTask('Agent-busy Sibling');
		await insertRunningRun(agentA, sibling);
		const wakeupId = await insertQueuedWakeup(agentA, taskId, { source: 'mention' });

		const res = await runNow(taskId, wakeupId);
		expect(res.status).toBe(409);

		const row = await db.query<{ status: string; last_skipped_reason: string | null }>(
			'SELECT status, last_skipped_reason FROM agent_wakeup_requests WHERE id = $1',
			[wakeupId],
		);
		expect(row.rows[0].status).toBe('queued');
		expect(row.rows[0].last_skipped_reason).toBe('agent_running');

		// The target task must not be left with an unreleased execution lock — that
		// stale lock is what drives a phantom "agent is running" badge.
		const locks = await db.query(
			'SELECT id FROM execution_locks WHERE task_id = $1 AND released_at IS NULL',
			[taskId],
		);
		expect(locks.rows.length).toBe(0);
		await clearRuns();
	});

	it('returns 409 when the task has an open dependency and the wakeup source is gated', async () => {
		await clearWakeups(taskId);
		await clearRuns();
		await addOpenBlocker(taskId);
		const wakeupId = await insertQueuedWakeup(agentB, taskId, { source: 'assignment' });

		const res = await runNow(taskId, wakeupId);
		expect(res.status).toBe(409);
		expect((await res.json()).error.message).toMatch(/dependency/i);

		// A blocked wakeup is parked as deferred by dispatchWakeupNow.
		const row = await db.query<{ status: string }>(
			'SELECT status FROM agent_wakeup_requests WHERE id = $1',
			[wakeupId],
		);
		expect(row.rows[0].status).toBe('deferred');
		await clearBlockers(taskId);
	});

	it('returns 409 when the wakeup is not queued', async () => {
		const wakeupId = await insertQueuedWakeup(agentB, taskId, { status: 'claimed' });
		const res = await runNow(taskId, wakeupId);
		expect(res.status).toBe(409);
	});

	it('returns 404 for an unknown wakeup id', async () => {
		const res = await runNow(taskId, '00000000-0000-0000-0000-000000000000');
		expect(res.status).toBe(404);
	});

	it('returns 404 when the wakeup belongs to a different task', async () => {
		const otherTask = await createTask('Run-now Other Task');
		const wakeupId = await insertQueuedWakeup(agentB, otherTask);
		const res = await runNow(taskId, wakeupId);
		expect(res.status).toBe(404);
		const row = await db.query<{ status: string }>(
			'SELECT status FROM agent_wakeup_requests WHERE id = $1',
			[wakeupId],
		);
		expect(row.rows[0].status).toBe('queued');
	});
});

describe('POST /teams/:teamId/tasks/:taskId/queued-wakeups/:wakeupId/cancel', () => {
	it('cancels a queued wakeup and posts a system comment', async () => {
		await clearWakeups(taskId);
		const wakeupId = await insertQueuedWakeup(agentB, taskId);

		const res = await app.request(
			`/api/projects/${projectId}/tasks/${taskId}/queued-wakeups/${wakeupId}/cancel`,
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
			`/api/projects/${projectId}/tasks/${taskId}/queued-wakeups/${wakeupId}/cancel`,
			{ method: 'POST', headers: { ...authHeader(token), ...json }, body: '{}' },
		);
		expect(res.status).toBe(409);
	});

	it('returns 404 for an unknown wakeup id', async () => {
		const res = await app.request(
			`/api/projects/${projectId}/tasks/${taskId}/queued-wakeups/00000000-0000-0000-0000-000000000000/cancel`,
			{ method: 'POST', headers: { ...authHeader(token), ...json }, body: '{}' },
		);
		expect(res.status).toBe(404);
	});

	it('returns 404 when the wakeup belongs to a different task', async () => {
		const otherTask = await createTask('Other Task');
		const wakeupId = await insertQueuedWakeup(agentB, otherTask);
		// Cancel via the original task's route — wrong task, must 404.
		const res = await app.request(
			`/api/projects/${projectId}/tasks/${taskId}/queued-wakeups/${wakeupId}/cancel`,
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

describe('POST /teams/:teamId/tasks/:taskId/runs/:runId/retry', () => {
	async function insertFailedRun(memberId: string, forTaskId: string): Promise<string> {
		const r = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at, finished_at, error)
			 VALUES ($1, $2, $3, 'failed'::heartbeat_run_status, now(), now(), 'API Error: socket closed')
			 RETURNING id`,
			[memberId, teamId, forTaskId],
		);
		return r.rows[0].id;
	}

	function retry(forTaskId: string, runId: string) {
		return app.request(`/api/projects/${projectId}/tasks/${forTaskId}/runs/${runId}/retry`, {
			method: 'POST',
			headers: { ...authHeader(token), ...json },
			body: '{}',
		});
	}

	it("creates an on_demand wakeup for the failed run's agent and dispatches it", async () => {
		await clearWakeups(taskId);
		await clearRuns();
		await clearBlockers(taskId);
		const runId = await insertFailedRun(agentB, taskId);

		const res = await retry(taskId, runId);
		expect(res.status).toBe(200);
		expect((await res.json()).data.dispatched).toBe(true);

		// A wakeup was created for the failed run's agent, carries the actor on
		// its payload (so the run comment surfaces "started by …"), and was
		// claimed by dispatch — no separate wakeup_started system comment.
		const wakeup = await db.query<{
			id: string;
			member_id: string;
			source: string;
			status: string;
			payload: {
				task_id?: string;
				source_run_id?: string;
				triggered_by?: { member_id: string | null; name: string };
			};
		}>(
			"SELECT id, member_id, source, status, payload FROM agent_wakeup_requests WHERE payload->>'task_id' = $1",
			[taskId],
		);
		expect(wakeup.rows.length).toBe(1);
		expect(wakeup.rows[0].member_id).toBe(agentB);
		expect(wakeup.rows[0].source).toBe('on_demand');
		expect(wakeup.rows[0].status).not.toBe('queued');
		expect(wakeup.rows[0].payload?.source_run_id).toBe(runId);
		expect(wakeup.rows[0].payload.triggered_by?.name).toBe('Test Admin');

		const sys = await db.query<{ content: { kind?: string } }>(
			"SELECT content FROM task_comments WHERE task_id = $1 AND content_type = 'system'",
			[taskId],
		);
		expect(sys.rows.some((s) => s.content?.kind === 'wakeup_started')).toBe(false);
	});

	it('returns 404 when the run id is unknown', async () => {
		const res = await retry(taskId, '00000000-0000-0000-0000-000000000000');
		expect(res.status).toBe(404);
	});

	it('returns 404 when the run belongs to a different task', async () => {
		const otherTask = await createTask('Retry Other Task');
		const runId = await insertFailedRun(agentB, otherTask);

		const res = await retry(taskId, runId);
		expect(res.status).toBe(404);
		await clearRuns();
	});

	it('returns 409 when the task already has a run in progress', async () => {
		await clearWakeups(taskId);
		await clearRuns();
		await insertRunningRun(agentA, taskId);
		const failedRunId = await insertFailedRun(agentB, taskId);

		const res = await retry(taskId, failedRunId);
		expect(res.status).toBe(409);
		await clearRuns();
	});
});
