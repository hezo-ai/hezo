import type { PGlite } from '@electric-sql/pglite';
import { COACH_AGENT_SLUG, HeartbeatRunStatus, WakeupSource, WakeupStatus } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	mintAgentToken,
} from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let projectId: string;
let projectSlug: string;
let agentId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const teamRes = await createTestTeam(db, { name: 'Reopen Co' });
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Reopen Project',
		description: 'Test project.',
	});
	const projectBody = (await projectRes.json()).data;
	projectId = projectBody.id;
	projectSlug = projectBody.slug;

	const agentRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Reopen Agent' }),
	});
	agentId = (await agentRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

async function insertTaskDirect(status: string, title: string): Promise<{ id: string }> {
	const meta = await db.query<{ task_prefix: string; number: number }>(
		`SELECT p.task_prefix, next_project_task_number(p.id) AS number
		 FROM projects p WHERE p.id = $1`,
		[projectId],
	);
	const n = meta.rows[0].number;
	const res = await db.query<{ id: string }>(
		`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier, title, status, priority, labels)
		 VALUES ($1, $2, $3, $4, $5, $6, $7::task_status, 'medium'::task_priority, '[]'::jsonb)
		 RETURNING id`,
		[teamId, projectId, agentId, n, `${meta.rows[0].task_prefix}-${n}`, title, status],
	);
	return res.rows[0];
}

function flushAsyncWakeups(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

async function reopenWakeups(taskId: string): Promise<{ source: string; trigger?: string }[]> {
	const rows = await db.query<{ source: string; payload: { trigger?: string } }>(
		`SELECT source::text AS source, payload FROM agent_wakeup_requests
		 WHERE payload->>'task_id' = $1`,
		[taskId],
	);
	return rows.rows.map((r) => ({ source: r.source, trigger: r.payload?.trigger }));
}

describe('re-opening a terminal task wakes the assignee', () => {
	it('fires an automation wakeup with trigger=task_reopened when an admin re-opens a cancelled task', async () => {
		const task = await insertTaskDirect('cancelled', 'Cancelled task to reopen');
		await db.query('DELETE FROM agent_wakeup_requests');

		const res = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'backlog' }),
		});
		expect(res.status).toBe(200);
		await flushAsyncWakeups();

		const wakeups = await reopenWakeups(task.id);
		const reopen = wakeups.find(
			(w) => w.source === WakeupSource.Automation && w.trigger === 'task_reopened',
		);
		expect(reopen).toBeDefined();
	});

	it('fires the re-open wakeup when an admin re-opens a done task', async () => {
		const task = await insertTaskDirect('done', 'Done task to reopen');
		await db.query('DELETE FROM agent_wakeup_requests');

		const res = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'in_progress' }),
		});
		expect(res.status).toBe(200);
		await flushAsyncWakeups();

		const wakeups = await reopenWakeups(task.id);
		expect(
			wakeups.some((w) => w.source === WakeupSource.Automation && w.trigger === 'task_reopened'),
		).toBe(true);
	});

	it('does NOT fire a re-open wakeup for a non-terminal status change', async () => {
		const task = await insertTaskDirect('backlog', 'Active task being moved');
		await db.query('DELETE FROM agent_wakeup_requests');

		const res = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'in_progress' }),
		});
		expect(res.status).toBe(200);
		await flushAsyncWakeups();

		const wakeups = await reopenWakeups(task.id);
		expect(wakeups.some((w) => w.trigger === 'task_reopened')).toBe(false);
	});

	it('still forbids an agent from re-opening a terminal task', async () => {
		const task = await insertTaskDirect('done', 'Done task agent cannot reopen');
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			task.id,
		);

		const res = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'backlog' }),
		});
		expect(res.status).toBe(403);

		const row = await db.query<{ status: string }>('SELECT status FROM tasks WHERE id = $1', [
			task.id,
		]);
		expect(row.rows[0].status).toBe('done');
	});
});

describe('re-opening a terminal task cancels pending Coach work', () => {
	async function poll(fn: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (await fn()) return;
			await new Promise((r) => setTimeout(r, 25));
		}
		throw new Error('poll: condition not met within timeout');
	}

	it('cancels the queued Coach wakeup and run, leaves other agents untouched', async () => {
		const coachRow = await db.query<{ id: string }>(
			'SELECT id FROM member_agents WHERE slug = $1 LIMIT 1',
			[COACH_AGENT_SLUG],
		);
		const coachId = coachRow.rows[0].id;

		const task = await insertTaskDirect('done', 'Done task with pending coach review');

		// A queued Coach wakeup + a queued Coach run targeting the task.
		const coachWakeup = await db.query<{ id: string }>(
			`INSERT INTO agent_wakeup_requests (member_id, team_id, source, payload)
			 VALUES ($1, $2, $3::wakeup_source, $4::jsonb) RETURNING id`,
			[
				coachId,
				teamId,
				WakeupSource.Automation,
				JSON.stringify({ task_id: task.id, trigger: 'task_done' }),
			],
		);
		const coachRun = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status)
			 VALUES ($1, $2, $3, $4::heartbeat_run_status) RETURNING id`,
			[coachId, teamId, task.id, HeartbeatRunStatus.Queued],
		);
		// A queued wakeup for the task's own assignee — must survive the re-open.
		const assigneeWakeup = await db.query<{ id: string }>(
			`INSERT INTO agent_wakeup_requests (member_id, team_id, source, payload)
			 VALUES ($1, $2, $3::wakeup_source, $4::jsonb) RETURNING id`,
			[agentId, teamId, WakeupSource.Mention, JSON.stringify({ task_id: task.id })],
		);

		const res = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'backlog' }),
		});
		expect(res.status).toBe(200);

		await poll(async () => {
			const w = await db.query<{ status: string }>(
				'SELECT status::text AS status FROM agent_wakeup_requests WHERE id = $1',
				[coachWakeup.rows[0].id],
			);
			return w.rows[0].status === WakeupStatus.Cancelled;
		});

		const coachRunStatus = await db.query<{ status: string }>(
			'SELECT status::text AS status FROM heartbeat_runs WHERE id = $1',
			[coachRun.rows[0].id],
		);
		expect(coachRunStatus.rows[0].status).toBe(HeartbeatRunStatus.Cancelled);

		// The assignee's own wakeup is untouched.
		const assignee = await db.query<{ status: string }>(
			'SELECT status::text AS status FROM agent_wakeup_requests WHERE id = $1',
			[assigneeWakeup.rows[0].id],
		);
		expect(assignee.rows[0].status).toBe(WakeupStatus.Queued);
	});
});
