import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let teamId: string;
let projectId: string;
let projectSlug: string;
let agentId: string;

interface TaskRow {
	id: string;
	identifier: string;
	last_run_status: string | null;
	last_run_id?: string | null;
	last_run_comment_id?: string | null;
	has_active_run: boolean;
	active_run?: { id: string; status: string; member_id: string } | null;
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const teamRes = await createTestTeam(db, { name: 'Last Run Co' });
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
	agentId = (await agentRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

async function createTask(title: string): Promise<string> {
	const res = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: projectId, title, assignee_id: agentId }),
	});
	return (await res.json()).data.id as string;
}

async function insertRun(
	taskId: string,
	status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out',
	finishedAt: Date | null,
): Promise<string> {
	const result = await db.query<{ id: string }>(
		`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at, finished_at)
		 VALUES ($1, $2, $3, $4::heartbeat_run_status, $5, $6)
		 RETURNING id`,
		[agentId, teamId, taskId, status, finishedAt ?? new Date(), finishedAt],
	);
	return result.rows[0].id;
}

async function insertRunComment(taskId: string, runId: string): Promise<string> {
	const result = await db.query<{ id: string }>(
		`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
		 VALUES ($1, $2, 'run'::comment_content_type, $3::jsonb)
		 RETURNING id`,
		[taskId, agentId, JSON.stringify({ run_id: runId, agent_id: agentId })],
	);
	return result.rows[0].id;
}

async function fetchListRow(taskId: string): Promise<TaskRow> {
	const res = await app.request(`/api/projects/${projectSlug}/tasks?per_page=200`, {
		headers: authHeader(token),
	});
	const body = await res.json();
	const row = (body.data as TaskRow[]).find((t) => t.id === taskId);
	if (!row) throw new Error(`Task ${taskId} not in list response`);
	return row;
}

async function fetchDetail(taskId: string): Promise<TaskRow> {
	const res = await app.request(`/api/projects/${projectSlug}/tasks/${taskId}`, {
		headers: authHeader(token),
	});
	return (await res.json()).data as TaskRow;
}

describe('task last-run fields', () => {
	it('returns null when the task has no runs', async () => {
		const taskId = await createTask('No runs');
		const listRow = await fetchListRow(taskId);
		const detail = await fetchDetail(taskId);
		expect(listRow.last_run_status).toBeNull();
		expect(detail.last_run_status).toBeNull();
		expect(detail.last_run_comment_id).toBeNull();
	});

	it('returns null when the only run is still queued or running', async () => {
		const taskId = await createTask('Only active');
		await insertRun(taskId, 'running', null);
		const listRow = await fetchListRow(taskId);
		const detail = await fetchDetail(taskId);
		expect(listRow.last_run_status).toBeNull();
		expect(detail.last_run_status).toBeNull();
		expect(detail.has_active_run).toBe(true);
	});

	it('names the active run, so the thread can tell which row is the live one', async () => {
		const taskId = await createTask('Active run id');
		const runId = await insertRun(taskId, 'running', null);
		const detail = await fetchDetail(taskId);
		// Without the id the thread can only guess which of its run rows is live -
		// and it guesses wrong the moment a task has more than one run.
		expect(detail.active_run?.id).toBe(runId);
		expect(detail.active_run?.status).toBe('running');
	});

	it('names the queued run when nothing is executing yet', async () => {
		const taskId = await createTask('Queued run id');
		const runId = await insertRun(taskId, 'queued', null);
		const detail = await fetchDetail(taskId);
		expect(detail.active_run?.id).toBe(runId);
		expect(detail.active_run?.status).toBe('queued');
	});

	it('prefers the executing run over a queued one, and names that one', async () => {
		const taskId = await createTask('Both states');
		await insertRun(taskId, 'queued', null);
		const runningId = await insertRun(taskId, 'running', null);
		const detail = await fetchDetail(taskId);
		expect(detail.active_run?.id).toBe(runningId);
		expect(detail.active_run?.status).toBe('running');
	});

	it('reports no active run once every run has finished', async () => {
		const taskId = await createTask('All done');
		await insertRun(taskId, 'succeeded', new Date());
		const detail = await fetchDetail(taskId);
		expect(detail.active_run ?? null).toBeNull();
		expect(detail.has_active_run).toBe(false);
	});

	it('exposes the run-start comment id for a failed run', async () => {
		const taskId = await createTask('One failure');
		const runId = await insertRun(taskId, 'failed', new Date());
		const commentId = await insertRunComment(taskId, runId);
		const listRow = await fetchListRow(taskId);
		const detail = await fetchDetail(taskId);
		expect(listRow.last_run_status).toBe('failed');
		expect(detail.last_run_status).toBe('failed');
		expect(detail.last_run_comment_id).toBe(commentId);
	});

	it('exposes the last run id as the retry target for a failed run', async () => {
		const taskId = await createTask('Retryable failure');
		const runId = await insertRun(taskId, 'failed', new Date());
		await insertRunComment(taskId, runId);
		const detail = await fetchDetail(taskId);
		expect(detail.last_run_status).toBe('failed');
		expect(detail.last_run_id).toBe(runId);
	});

	it('picks the most recent completed run when history exists', async () => {
		const taskId = await createTask('History wins');
		const earlier = await insertRun(taskId, 'succeeded', new Date(Date.now() - 60_000));
		await insertRunComment(taskId, earlier);
		const later = await insertRun(taskId, 'failed', new Date());
		const laterCommentId = await insertRunComment(taskId, later);
		const detail = await fetchDetail(taskId);
		expect(detail.last_run_status).toBe('failed');
		expect(detail.last_run_id).toBe(later);
		expect(detail.last_run_comment_id).toBe(laterCommentId);
	});

	it('still reports the previous failure when a retry is currently running', async () => {
		const taskId = await createTask('Failure plus retry');
		const failed = await insertRun(taskId, 'failed', new Date(Date.now() - 60_000));
		const failedCommentId = await insertRunComment(taskId, failed);
		await insertRun(taskId, 'running', null);
		const detail = await fetchDetail(taskId);
		expect(detail.last_run_status).toBe('failed');
		expect(detail.last_run_comment_id).toBe(failedCommentId);
		expect(detail.has_active_run).toBe(true);
	});

	it('returns timed_out distinctly from failed', async () => {
		const taskId = await createTask('Timed out');
		const runId = await insertRun(taskId, 'timed_out', new Date());
		await insertRunComment(taskId, runId);
		const detail = await fetchDetail(taskId);
		expect(detail.last_run_status).toBe('timed_out');
	});
});
