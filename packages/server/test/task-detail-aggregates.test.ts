import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let teamId: string;
let projectId: string;
let projectSlug: string;
let agentId: string;
let agentSlug: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const teamRes = await createTestTeam(db, { name: 'Aggregates Co' });
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, { name: 'Main' });
	const projectData = (await projectRes.json()).data;
	projectId = projectData.id;
	projectSlug = projectData.slug;

	const agentRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Runner' }),
	});
	const agent = (await agentRes.json()).data;
	agentId = agent.id;
	agentSlug = agent.slug;
});

afterAll(async () => {
	await safeClose(db);
});

async function createTask(title: string, assignee?: string): Promise<string> {
	const res = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: projectId, title, assignee_id: assignee }),
	});
	return (await res.json()).data.id as string;
}

async function getTask(taskId: string) {
	const res = await app.request(`/api/projects/${projectSlug}/tasks/${taskId}`, {
		headers: authHeader(token),
	});
	expect(res.status).toBe(200);
	return (await res.json()).data;
}

it('aggregates run count, finished-run duration and cost onto the task detail', async () => {
	const taskId = await createTask('Aggregate me', agentId);

	// Two finished runs (120s + 41s of wall-clock) plus a queued run that never
	// started — the queued one must not count toward run_count or duration.
	await db.query(
		`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at, finished_at)
		 VALUES ($1,$2,$3,'succeeded'::heartbeat_run_status,'2026-01-01T00:00:00Z','2026-01-01T00:02:00Z'),
		        ($1,$2,$3,'failed'::heartbeat_run_status,'2026-01-01T00:00:00Z','2026-01-01T00:00:41Z'),
		        ($1,$2,$3,'queued'::heartbeat_run_status,NULL,NULL)`,
		[agentId, teamId, taskId],
	);
	// Two cost entries totalling $2.97 (cost_entries lost its team dimension in 004).
	await db.query(
		`INSERT INTO cost_entries (member_id, task_id, project_id, amount_cents)
		 VALUES ($1,$2,$3,186),($1,$2,$3,111)`,
		[agentId, taskId, projectId],
	);

	const task = await getTask(taskId);
	expect(task.run_count).toBe(2);
	expect(task.total_duration_seconds).toBe(161);
	expect(task.total_cost_cents).toBe(297);
	expect(task.assignee_slug).toBe(agentSlug);
});

it('returns zeroed aggregates for a task with no runs or costs', async () => {
	const taskId = await createTask('Fresh task', agentId);
	const task = await getTask(taskId);
	expect(task.run_count).toBe(0);
	expect(task.total_duration_seconds).toBe(0);
	expect(task.total_cost_cents).toBe(0);
	expect(task.assignee_slug).toBe(agentSlug);
});
