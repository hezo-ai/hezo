import type { PGlite } from '@electric-sql/pglite';
import { PlatformType, TaskStatus } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/lib/types';
import { enqueueOAuthVerificationTask } from '../src/services/oauth-verification-tasks';
import { triggerStatusAutomations } from '../src/services/task-automation';
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
		body: JSON.stringify({ name: 'OAuth Auto Co', template_id: typeId }),
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

async function createParentTask(title = 'Originating ticket'): Promise<string> {
	const meta = await db.query<{ task_prefix: string; number: number }>(
		`SELECT p.task_prefix, next_project_task_number(p.id) AS number
		 FROM projects p WHERE p.id = $1`,
		[parentProjectId],
	);
	const row = meta.rows[0];
	const inserted = await db.query<{ id: string }>(
		`INSERT INTO tasks (team_id, project_id, number, identifier, title)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING id`,
		[teamId, parentProjectId, row.number, `${row.task_prefix}-${row.number}`, title],
	);
	return inserted.rows[0].id;
}

describe('triggerStatusAutomations: OAuth verification done', () => {
	it('posts a Captain-authored comment on the parent when the verification task moves to done', async () => {
		const parentId = await createParentTask();
		const verif = await enqueueOAuthVerificationTask(db, teamId, PlatformType.GitHub, parentId, {});
		expect(verif?.taskId).toBeTruthy();

		await db.query('UPDATE tasks SET status = $1::task_status WHERE id = $2', [
			TaskStatus.Done,
			verif!.taskId,
		]);
		await triggerStatusAutomations(
			db,
			teamId,
			verif!.taskId,
			TaskStatus.Backlog,
			TaskStatus.Done,
			null,
			undefined,
		);

		const comments = await db.query<{
			content: { text?: string };
			author_member_id: string | null;
			content_type: string;
		}>('SELECT content, author_member_id, content_type FROM task_comments WHERE task_id = $1', [
			parentId,
		]);
		const ceoComment = comments.rows.find((c) => c.author_member_id === captainMemberId);
		expect(ceoComment).toBeTruthy();
		expect(ceoComment?.content_type).toBe('text');
		expect(ceoComment?.content.text).toContain('GitHub');
		expect(ceoComment?.content.text?.toLowerCase()).toContain('verified');
	});

	it('does nothing when the done task has no parent_task_id', async () => {
		const verif = await enqueueOAuthVerificationTask(db, teamId, PlatformType.Stripe, null, {});
		const commentsBefore = await db.query<{ count: string }>(
			`SELECT count(*)::text AS count FROM task_comments
			 WHERE author_member_id = $1`,
			[captainMemberId],
		);

		await db.query('UPDATE tasks SET status = $1::task_status WHERE id = $2', [
			TaskStatus.Done,
			verif!.taskId,
		]);
		await triggerStatusAutomations(
			db,
			teamId,
			verif!.taskId,
			TaskStatus.Backlog,
			TaskStatus.Done,
			null,
			undefined,
		);

		const commentsAfter = await db.query<{ count: string }>(
			`SELECT count(*)::text AS count FROM task_comments
			 WHERE author_member_id = $1`,
			[captainMemberId],
		);
		expect(commentsAfter.rows[0].count).toBe(commentsBefore.rows[0].count);
	});

	it('does nothing when a non-verification task moves to done (beyond the Coach wake-up)', async () => {
		const parentId = await createParentTask('Plain task');
		const before = await db.query<{ count: string }>(
			'SELECT count(*)::text AS count FROM task_comments WHERE task_id = $1',
			[parentId],
		);

		await db.query('UPDATE tasks SET status = $1::task_status WHERE id = $2', [
			TaskStatus.Done,
			parentId,
		]);
		await triggerStatusAutomations(
			db,
			teamId,
			parentId,
			TaskStatus.Backlog,
			TaskStatus.Done,
			null,
			undefined,
		);

		const after = await db.query<{ count: string }>(
			'SELECT count(*)::text AS count FROM task_comments WHERE task_id = $1',
			[parentId],
		);
		expect(Number.parseInt(after.rows[0].count, 10)).toBe(
			Number.parseInt(before.rows[0].count, 10) + 1,
		);
		const sysComment = await db.query<{ content: { kind?: string; from?: string; to?: string } }>(
			`SELECT content FROM task_comments
			 WHERE task_id = $1 AND content_type = 'system'
			 ORDER BY created_at DESC LIMIT 1`,
			[parentId],
		);
		expect(sysComment.rows[0]?.content.kind).toBe('status_change');
		expect(sysComment.rows[0]?.content.to).toBe(TaskStatus.Done);
	});
});
