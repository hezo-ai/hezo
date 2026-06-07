import type { PGlite } from '@electric-sql/pglite';
import { PlatformType, TaskStatus } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/lib/types';
import { enqueueOAuthVerificationTask } from '../src/services/oauth-verification-tasks';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let teamId: string;
let captainMemberId: string;
let parentProjectId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: Record<string, unknown>) => t.name === 'Startup',
	).id;

	const teamRes = await app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'OAuth Verif Co', template_id: typeId }),
	});
	teamId = (await teamRes.json()).data.id;

	const captain = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = 'captain'`,
		[teamId],
	);
	captainMemberId = captain.rows[0].id;

	const ops = await db.query<{ id: string }>(
		`SELECT id FROM projects WHERE team_id = $1 AND is_internal = true`,
		[teamId],
	);
	parentProjectId = ops.rows[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

beforeEach(async () => {
	await db.query(`DELETE FROM tasks WHERE labels @> '["oauth-verification"]'::jsonb`);
});

describe('enqueueOAuthVerificationTask', () => {
	it('creates an Internal task assigned to the Captain with high priority and the label', async () => {
		const result = await enqueueOAuthVerificationTask(db, teamId, PlatformType.GitHub, null, {
			username: 'octocat',
		});
		expect(result).toBeTruthy();
		expect(result?.created).toBe(true);

		const row = await db.query<{
			project_id: string;
			assignee_id: string;
			parent_task_id: string | null;
			title: string;
			description: string;
			labels: string[];
			priority: string;
			status: string;
		}>(
			`SELECT project_id, assignee_id, parent_task_id, title, description, labels, priority, status
			 FROM tasks WHERE id = $1`,
			[result!.taskId],
		);
		const task = row.rows[0];
		expect(task.assignee_id).toBe(captainMemberId);
		expect(task.parent_task_id).toBeNull();

		const ops = await db.query<{ id: string }>(
			`SELECT id FROM projects WHERE team_id = $1 AND is_internal = true`,
			[teamId],
		);
		expect(task.project_id).toBe(ops.rows[0].id);

		expect(task.labels).toEqual(expect.arrayContaining(['internal', 'oauth-verification']));
		expect(task.priority).toBe('high');
		expect(task.status).toBe('backlog');
		expect(task.title).toContain('GitHub');
		expect(task.description).toContain('oauth-verify platform=github');
		expect(task.description).toContain('octocat');
	});

	it('links the new task to the originating task via parent_task_id', async () => {
		const meta = await db.query<{ task_prefix: string; number: number }>(
			`SELECT p.task_prefix, next_project_task_number(p.id) AS number
			 FROM projects p WHERE p.id = $1`,
			[parentProjectId],
		);
		const parent = await db.query<{ id: string; identifier: string }>(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title)
			 VALUES ($1, $2, $3, $4, 'Originating ticket')
			 RETURNING id, identifier`,
			[
				teamId,
				parentProjectId,
				meta.rows[0].number,
				`${meta.rows[0].task_prefix}-${meta.rows[0].number}`,
			],
		);
		const parentId = parent.rows[0].id;

		const result = await enqueueOAuthVerificationTask(
			db,
			teamId,
			PlatformType.GitHub,
			parentId,
			{},
		);
		expect(result?.created).toBe(true);

		const row = await db.query<{ parent_task_id: string | null; description: string }>(
			'SELECT parent_task_id, description FROM tasks WHERE id = $1',
			[result!.taskId],
		);
		expect(row.rows[0].parent_task_id).toBe(parentId);
		expect(row.rows[0].description).toContain(parent.rows[0].identifier);
	});

	it('dedups by returning the existing open task and posting a system comment', async () => {
		const first = await enqueueOAuthVerificationTask(db, teamId, PlatformType.GitHub, null, {});
		const second = await enqueueOAuthVerificationTask(db, teamId, PlatformType.GitHub, null, {});
		expect(second?.taskId).toBe(first?.taskId);
		expect(second?.created).toBe(false);

		const comments = await db.query<{ content_type: string }>(
			'SELECT content_type FROM task_comments WHERE task_id = $1',
			[first!.taskId],
		);
		expect(comments.rows.some((c) => c.content_type === 'system')).toBe(true);
	});

	it('creates a wakeup for the Captain when enqueueing', async () => {
		const result = await enqueueOAuthVerificationTask(db, teamId, PlatformType.GitHub, null, {});
		const wakeups = await db.query<{ source: string; payload: Record<string, unknown> }>(
			`SELECT source, payload FROM agent_wakeup_requests WHERE member_id = $1`,
			[captainMemberId],
		);
		expect(
			wakeups.rows.some((w) => w.source === 'assignment' && w.payload.task_id === result!.taskId),
		).toBe(true);
	});

	it('creates a separate task per platform', async () => {
		const github = await enqueueOAuthVerificationTask(db, teamId, PlatformType.GitHub, null, {});
		const stripe = await enqueueOAuthVerificationTask(db, teamId, PlatformType.Stripe, null, {});
		expect(github?.taskId).not.toBe(stripe?.taskId);
		expect(github?.created).toBe(true);
		expect(stripe?.created).toBe(true);
	});

	it('closes the dedup window when the prior task reaches a terminal status', async () => {
		const first = await enqueueOAuthVerificationTask(db, teamId, PlatformType.GitHub, null, {});
		await db.query('UPDATE tasks SET status = $1::task_status WHERE id = $2', [
			TaskStatus.Done,
			first!.taskId,
		]);
		const second = await enqueueOAuthVerificationTask(db, teamId, PlatformType.GitHub, null, {});
		expect(second?.taskId).not.toBe(first?.taskId);
		expect(second?.created).toBe(true);
	});
});
