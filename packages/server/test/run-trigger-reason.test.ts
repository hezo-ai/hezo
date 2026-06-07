import type { PGlite } from '@electric-sql/pglite';
import { CommentContentType, WakeupSource } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, projectSlugFor } from './helpers/app';

interface RunRow {
	id: string;
	trigger_source: string | null;
	trigger_payload: Record<string, unknown> | null;
	trigger_comment_id: string | null;
	trigger_actor_member_id: string | null;
	trigger_actor_slug: string | null;
	trigger_actor_title: string | null;
	trigger_comment_task_id: string | null;
	trigger_comment_task_identifier: string | null;
	trigger_comment_project_slug: string | null;
}

let app: Hono<Env>;
let db: PGlite;
let token: string;
let masterKeyManager: MasterKeyManager;

let teamId: string;
let projectId: string;
let internalProjectSlug: string;
let architectId: string;
let productLeadId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;
	void masterKeyManager;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: Record<string, unknown>) => t.name === 'Startup',
	).id;

	const teamRes = await app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Trigger Reason Co', template_id: typeId }),
	});
	const teamData = (await teamRes.json()).data;
	teamId = teamData.id;
	internalProjectSlug = `${await projectSlugFor(db, teamData.id)}`;

	const agentsRes = await app.request(`/api/projects/${internalProjectSlug}/agents`, {
		headers: authHeader(token),
	});
	const agents = (await agentsRes.json()).data as Array<{ id: string; slug: string }>;
	architectId = agents.find((a) => a.slug === 'architect')!.id;
	productLeadId = agents.find((a) => a.slug === 'product-lead')!.id;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Test Project',
		description: 'x',
	});
	projectId = (await projectRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

async function insertTask(assigneeId: string, title: string): Promise<string> {
	const meta = await db.query<{ task_prefix: string; number: number }>(
		`SELECT p.task_prefix, next_project_task_number(p.id) AS number
		 FROM projects p WHERE p.id = $1`,
		[projectId],
	);
	const n = meta.rows[0].number;
	const res = await db.query<{ id: string }>(
		`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier, title, status, priority, labels)
		 VALUES ($1, $2, $3, $4, $5, $6, 'backlog'::task_status, 'medium'::task_priority, '[]'::jsonb)
		 RETURNING id`,
		[teamId, projectId, assigneeId, n, `${meta.rows[0].task_prefix}-${n}`, title],
	);
	return res.rows[0].id;
}

async function insertWakeup(
	memberId: string,
	source: string,
	payload: Record<string, unknown>,
): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload, claimed_at)
		 VALUES ($1, $2, $3::wakeup_source, 'completed'::wakeup_status, $4::jsonb, now())
		 RETURNING id`,
		[memberId, teamId, source, JSON.stringify(payload)],
	);
	return r.rows[0].id;
}

async function insertRun(
	memberId: string,
	wakeupId: string,
	taskId: string | null,
): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO heartbeat_runs (member_id, team_id, task_id, wakeup_id, status, started_at, finished_at)
		 VALUES ($1, $2, $3, $4, 'succeeded'::heartbeat_run_status, now() - interval '1 minute', now())
		 RETURNING id`,
		[memberId, teamId, taskId, wakeupId],
	);
	return r.rows[0].id;
}

async function insertComment(
	taskId: string,
	authorMemberId: string | null,
	text: string,
): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
		 VALUES ($1, $2, $3::comment_content_type, $4::jsonb)
		 RETURNING id`,
		[taskId, authorMemberId, CommentContentType.Text, JSON.stringify({ text })],
	);
	return r.rows[0].id;
}

async function fetchRun(agentId: string, runId: string): Promise<RunRow> {
	const res = await app.request(
		`/api/projects/${internalProjectSlug}/agents/${agentId}/heartbeat-runs/${runId}`,
		{ headers: authHeader(token) },
	);
	expect(res.status).toBe(200);
	return (await res.json()).data;
}

describe('GET /heartbeat-runs/:runId trigger reason', () => {
	it('resolves mention trigger to actor + task + comment', async () => {
		const taskId = await insertTask(architectId, 'Task with mention');
		const commentId = await insertComment(taskId, productLeadId, '@architect please review');
		const wakeupId = await insertWakeup(architectId, WakeupSource.Mention, {
			source: WakeupSource.Mention,
			task_id: taskId,
			comment_id: commentId,
		});
		const runId = await insertRun(architectId, wakeupId, taskId);

		const run = await fetchRun(architectId, runId);
		expect(run.trigger_source).toBe(WakeupSource.Mention);
		expect(run.trigger_comment_id).toBe(commentId);
		expect(run.trigger_actor_member_id).toBe(productLeadId);
		expect(run.trigger_actor_slug).toBe('product-lead');
		expect(run.trigger_comment_task_id).toBe(taskId);
		expect(run.trigger_comment_task_identifier).toBeTruthy();
		expect(run.trigger_comment_project_slug).toBe('test-project');
	});

	it('resolves reply trigger via the new comment author', async () => {
		const taskId = await insertTask(productLeadId, 'Task with reply');
		const originalCommentId = await insertComment(taskId, productLeadId, 'original');
		const replyCommentId = await insertComment(taskId, architectId, 'replying back');
		const wakeupId = await insertWakeup(productLeadId, WakeupSource.Reply, {
			source: WakeupSource.Reply,
			task_id: taskId,
			comment_id: replyCommentId,
			triggering_comment_id: originalCommentId,
			responder_member_id: architectId,
		});
		const runId = await insertRun(productLeadId, wakeupId, taskId);

		const run = await fetchRun(productLeadId, runId);
		expect(run.trigger_source).toBe(WakeupSource.Reply);
		expect(run.trigger_comment_id).toBe(replyCommentId);
		expect(run.trigger_actor_slug).toBe('architect');
	});

	it('returns null trigger fields for legacy runs without wakeup_id', async () => {
		const taskId = await insertTask(architectId, 'Legacy run task');
		const r = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at, finished_at)
			 VALUES ($1, $2, $3, 'succeeded'::heartbeat_run_status, now() - interval '1 minute', now())
			 RETURNING id`,
			[architectId, teamId, taskId],
		);
		const run = await fetchRun(architectId, r.rows[0].id);
		expect(run.trigger_source).toBeNull();
		expect(run.trigger_comment_id).toBeNull();
		expect(run.trigger_actor_slug).toBeNull();
	});

	it('returns trigger_source for non-comment wakeup sources without resolved comment fields', async () => {
		const taskId = await insertTask(architectId, 'Assignment task');
		const wakeupId = await insertWakeup(architectId, WakeupSource.Assignment, {
			task_id: taskId,
		});
		const runId = await insertRun(architectId, wakeupId, taskId);

		const run = await fetchRun(architectId, runId);
		expect(run.trigger_source).toBe(WakeupSource.Assignment);
		expect(run.trigger_comment_id).toBeNull();
		expect(run.trigger_actor_slug).toBeNull();
	});

	it('returns heartbeat trigger for scheduled-heartbeat wakeups', async () => {
		const wakeupId = await insertWakeup(architectId, WakeupSource.Heartbeat, {
			reason: 'scheduled_heartbeat',
		});
		const runId = await insertRun(architectId, wakeupId, null);

		const run = await fetchRun(architectId, runId);
		expect(run.trigger_source).toBe(WakeupSource.Heartbeat);
		expect(run.trigger_payload).toMatchObject({ reason: 'scheduled_heartbeat' });
	});
});
