import { RunCancelReason, WakeupStatus } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { terminateHeartbeatRun } from '../src/services/run-termination';
import { settleWakeupForRun } from '../src/services/wakeup';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	projectSlugFor,
} from './helpers/app';

let app: Hono<Env>;
let db: Db;
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

async function getRunRow(
	runId: string,
): Promise<{ status: string; error: string | null; cancel_reason: string | null }> {
	const r = await db.query<{ status: string; error: string | null; cancel_reason: string | null }>(
		'SELECT status, error, cancel_reason FROM heartbeat_runs WHERE id = $1',
		[runId],
	);
	return r.rows[0];
}

async function getWakeupStatus(runId: string): Promise<string | undefined> {
	const r = await db.query<{ status: string }>(
		`SELECT w.status FROM agent_wakeup_requests w
		 JOIN heartbeat_runs hr ON hr.wakeup_id = w.id WHERE hr.id = $1`,
		[runId],
	);
	return r.rows[0]?.status;
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

	const teamRes = await createTestTeam(db, { name: 'Terminate Test Co' });
	const teamData = (await teamRes.json()).data;
	teamId = teamData.id;
	const teamSlug = teamData.slug;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Main',
		description: 'Test project.',
	});
	projectId = (await projectRes.json()).data.id;

	const agentRes = await app.request(`/api/projects/${await projectSlugFor(db, teamId)}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Test Runner' }),
	});
	agentId = (await agentRes.json()).data.id;

	const taskRes = await app.request(`/api/projects/${projectId}/tasks`, {
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
			`/api/projects/${projectId}/agents/${agentId}/heartbeat-runs/${runId}/terminate`,
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
		// A person chose to stop this, so no Retry is offered and the work is not
		// owed. Recording it structurally is what keeps that decision out of the
		// error prose every reader would otherwise have to parse.
		expect(row.cancel_reason).toBe(RunCancelReason.OperatorTerminated);

		// Settled here rather than left `claimed` for healStaleRunState to record
		// as `failed` two minutes later. Both were the wrong label for withdrawn
		// work, and a still-claimed row suppresses chainNextTaskWakeup meanwhile.
		expect(await getWakeupStatus(runId)).toBe(WakeupStatus.Cancelled);

		const sysComments = await getSystemComments(taskId);
		const terminationComment = sysComments.find(
			(c) => c.content?.kind === 'run_terminated' && c.content?.run_id === runId,
		);
		expect(terminationComment).toBeTruthy();
		expect(terminationComment?.content?.reason).toBe('Terminated by user');
	});

	it("a running run keeps the human's attribution once its abort cascades", async () => {
		// The `wasLive` branch, which every other case here misses: `makeRun()`
		// rows are not registered with the JobManager, so `cancelLiveRun` always
		// returned false and this half was never executed. It is where the two
		// races the change had to settle both live - the run is still in flight,
		// and its own finalizer reaches the row and the wakeup moments later.
		const runId = await makeRun('running');
		const liveJobManager = {
			cancelLiveRun: () => true,
		} as unknown as Parameters<typeof terminateHeartbeatRun>[0]['jobManager'];

		const result = await terminateHeartbeatRun(
			{ db, wsManager: undefined, jobManager: liveJobManager },
			runId,
			'Terminated by user',
			null,
		);
		expect(result.terminated).toBe(true);

		// Backfilled while the abort is still cascading; the row stays `running`
		// until the runner's own finalizer lands.
		const backfilled = await getRunRow(runId);
		expect(backfilled.cancel_reason).toBe(RunCancelReason.OperatorTerminated);
		expect(await getWakeupStatus(runId)).toBe(WakeupStatus.Cancelled);

		// Now the runner finalizes it. `updateHeartbeatRun` writes
		// `COALESCE(cancel_reason, $n)`, so the person's attribution survives - the
		// opposite direction overwrote it with the runner's own vaguer verdict.
		await db.query(
			`UPDATE heartbeat_runs
			    SET status = 'cancelled'::heartbeat_run_status,
			        cancel_reason = COALESCE(cancel_reason, $2)
			  WHERE id = $1`,
			[runId, RunCancelReason.HandedBack],
		);
		expect((await getRunRow(runId)).cancel_reason).toBe(RunCancelReason.OperatorTerminated);

		// And its wakeup settlement survives too: the terminal arm declines to
		// relabel a wakeup that already reached a terminal status, so work somebody
		// withdrew is not reported as work that failed.
		await settleWakeupForRun(
			db,
			(
				await db.query<{ wakeup_id: string }>(
					'SELECT wakeup_id FROM heartbeat_runs WHERE id = $1',
					[runId],
				)
			).rows[0].wakeup_id,
			{ kind: 'fail' },
		);
		expect(await getWakeupStatus(runId)).toBe(WakeupStatus.Cancelled);
	});

	it('returns 409 when the run is already terminal', async () => {
		const runId = await makeRun('queued');
		await db.query(
			"UPDATE heartbeat_runs SET status = 'succeeded'::heartbeat_run_status, finished_at = now() WHERE id = $1",
			[runId],
		);

		const res = await app.request(
			`/api/projects/${projectId}/agents/${agentId}/heartbeat-runs/${runId}/terminate`,
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
			`/api/projects/${projectId}/agents/${agentId}/heartbeat-runs/${fakeId}/terminate`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: '{}',
			},
		);
		expect(res.status).toBe(404);
	});
});

describe('PATCH /tasks status → Cancelled', () => {
	it('auto-terminates queued runs when task is cancelled', async () => {
		const runId = await makeRun('queued');

		const res = await app.request(`/api/projects/${projectId}/tasks/${taskId}`, {
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
		// Withdrawn, not operator-terminated: nobody stopped this run, the work it
		// was doing stopped being wanted. Both mean no Retry, and they differ only
		// in what a reader is told.
		expect(row.cancel_reason).toBe(RunCancelReason.WorkWithdrawn);

		const sysComments = await getSystemComments(taskId);
		const terminationComment = sysComments.find(
			(c) => c.content?.kind === 'run_terminated' && c.content?.run_id === runId,
		);
		expect(terminationComment).toBeTruthy();
	});

	it('auto-terminates queued runs when task is cancelled', async () => {
		await db.query("UPDATE tasks SET status = 'backlog'::task_status WHERE id = $1", [taskId]);
		const runId = await makeRun('queued');

		const res = await app.request(`/api/projects/${projectId}/tasks/${taskId}`, {
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
