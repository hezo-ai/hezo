import { DEFAULT_TEAM_ID, PlatformType, TaskStatus } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import { enqueueOAuthVerificationTask } from '../src/services/oauth-verification-tasks';
import { triggerStatusAutomations } from '../src/services/task-automation';
import { safeClose } from './helpers';
import { createTestApp } from './helpers/app';

let db: Db;
// OAuth verification is instance-level: tasks live in the HQ team's HQ project
// and are owned by the CEO. Originating tickets used by these flows therefore
// also live in HQ so the verification task can link to them.
let teamId: string;
let parentProjectId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;

	teamId = DEFAULT_TEAM_ID;

	const hq = await db.query<{ id: string }>(
		`SELECT id FROM projects WHERE team_id = $1 AND is_internal = true`,
		[teamId],
	);
	parentProjectId = hq.rows[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

async function createParentTask(title = 'Originating task'): Promise<string> {
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
	it('posts a confirmation comment on the parent when the verification task moves to done', async () => {
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
			null,
		);

		const comments = await db.query<{
			content: { text?: string };
			author_member_id: string | null;
			content_type: string;
		}>('SELECT content, author_member_id, content_type FROM task_comments WHERE task_id = $1', [
			parentId,
		]);
		const confirmation = comments.rows.find(
			(c) => c.content_type === 'text' && c.content.text?.toLowerCase().includes('verified'),
		);
		expect(confirmation).toBeTruthy();
		// HQ hosts the CEO and Coach but no Captain, so the verification-confirmation
		// comment is authored by the system (no member) rather than a per-team agent.
		expect(confirmation?.author_member_id).toBeNull();
		expect(confirmation?.content.text).toContain('GitHub');
	});

	it('does nothing when the done task has no parent_task_id', async () => {
		const verif = await enqueueOAuthVerificationTask(db, teamId, PlatformType.Stripe, null, {});
		// With no originating ticket there is nowhere to post a confirmation, so the
		// count of verification-confirmation comments must not change.
		const confirmationCount = async () => {
			const r = await db.query<{ count: string }>(
				`SELECT count(*)::text AS count FROM task_comments
				 WHERE content_type = 'text'
				   AND content->>'text' ILIKE '%verified%'`,
			);
			return r.rows[0].count;
		};
		const before = await confirmationCount();

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
			null,
		);

		expect(await confirmationCount()).toBe(before);
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
			null,
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
