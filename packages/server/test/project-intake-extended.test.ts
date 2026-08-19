import { TaskStatus } from '@hezo/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import {
	completeProjectIntakeAfterProvisioning,
	createProjectIntake,
	getOpenProjectIntakeForHome,
	getOpenProjectIntakeTasks,
} from '../src/services/project-intake';
import { safeClose } from './helpers';
import { createTestApp } from './helpers/app';

let db: Db;

beforeAll(async () => {
	// createTestApp seeds the HQ team + CEO so loadCoordinationContext resolves.
	const ctx = await createTestApp();
	db = ctx.db;
});

afterAll(async () => {
	await safeClose(db);
});

beforeEach(async () => {
	// Each test starts from a clean intake slate (intakes all live in HQ).
	await db.query(`DELETE FROM task_comments WHERE task_id IN
		(SELECT id FROM tasks WHERE labels @> '["project-intake"]'::jsonb)`);
	await db.query(`DELETE FROM tasks WHERE labels @> '["project-intake"]'::jsonb`);
	await db.query('DELETE FROM agent_wakeup_requests');
});

describe('createProjectIntake (service)', () => {
	it('attaches the initial project plan as a second CEO comment', async () => {
		const result = await createProjectIntake(db, {
			name: 'Planned App',
			description: 'An app with a plan',
			initialProjectPlan: '# The Plan\n\nDo the thing.',
			baselineTeamTypeName: 'App Team',
			baselineTemplateId: '00000000-0000-0000-0000-0000000000aa',
		});
		expect(result).not.toBeNull();

		const comments = await db.query<{ content: { text: string } }>(
			`SELECT content FROM task_comments WHERE task_id = $1 ORDER BY created_at ASC`,
			[result!.intakeTaskId],
		);
		// Greeting + plan attachment.
		expect(comments.rows.length).toBe(2);
		expect(comments.rows[0].content.text).toContain("I'm the CEO");
		expect(comments.rows[1].content.text).toContain('Project plan attached');
		expect(comments.rows[1].content.text).toContain('Do the thing.');

		// The greeting mentions the suggested team type and the plan attachment.
		expect(comments.rows[0].content.text).toContain('App Team');
		expect(comments.rows[0].content.text).toContain("I'll attach your project plan");

		// The greeting must NOT echo the description back — it already lives in the
		// ticket description, so re-posting it as a comment is pure duplication.
		expect(comments.rows[0].content.text).not.toContain('An app with a plan');

		// No wakeup fires. The greeting is the CEO's opening ask, so a run started
		// here would only re-introduce and re-ask it; the admin's reply is what wakes
		// the CEO. The inbox row is how the intake reaches them meanwhile.
		const wakeup = await db.query<{ c: number }>(
			`SELECT count(*)::int AS c FROM agent_wakeup_requests WHERE member_id = $1`,
			[result!.ceoMemberId],
		);
		expect(wakeup.rows[0].c).toBe(0);

		const mentions = await db.query<{ c: number }>(
			'SELECT count(*)::int AS c FROM admin_mentions WHERE task_id = $1',
			[result!.intakeTaskId],
		);
		expect(mentions.rows[0].c).toBeGreaterThan(0);
	});

	it('records a clone baseline line when a source team id is supplied', async () => {
		const result = await createProjectIntake(db, {
			name: 'Cloned App',
			description: 'desc',
			initialProjectPlan: null,
			baselineSourceTeamId: '11111111-1111-1111-1111-111111111111',
			baselineTeamTypeName: 'Existing Co',
		});
		expect(result).not.toBeNull();
		const task = await db.query<{ description: string }>(
			`SELECT description FROM tasks WHERE id = $1`,
			[result!.intakeTaskId],
		);
		expect(task.rows[0].description).toContain('clone of "Existing Co"');
		expect(task.rows[0].description).toContain('11111111-1111-1111-1111-111111111111');
	});
});

describe('getOpenProjectIntakeForHome / getOpenProjectIntakeTasks', () => {
	it('returns null when there are no open intakes', async () => {
		expect(await getOpenProjectIntakeForHome(db)).toBeNull();
		expect(await getOpenProjectIntakeTasks(db)).toEqual([]);
	});

	it('surfaces the first open intake enriched with the CEO greeting + identity', async () => {
		const created = await createProjectIntake(db, {
			name: 'Home App',
			description: 'home desc',
			initialProjectPlan: null,
		});
		expect(created).not.toBeNull();

		const home = await getOpenProjectIntakeForHome(db);
		expect(home).not.toBeNull();
		expect(home!.task_id).toBe(created!.intakeTaskId);
		expect(home!.project_slug).toBe('hq');
		expect(home!.greeting).toContain("I'm the CEO");
		expect(home!.ceo_member_id).toBeTruthy();
		expect(home!.ceo_title).toBeTruthy();

		const all = await getOpenProjectIntakeTasks(db);
		expect(all.length).toBe(1);
		expect(all[0].task_id).toBe(created!.intakeTaskId);
	});

	it('excludes intakes once their task reaches a terminal status', async () => {
		const created = await createProjectIntake(db, {
			name: 'Done App',
			description: 'will be closed',
			initialProjectPlan: null,
		});
		await db.query(`UPDATE tasks SET status = $1::task_status WHERE id = $2`, [
			TaskStatus.Done,
			created!.intakeTaskId,
		]);
		expect(await getOpenProjectIntakeTasks(db)).toEqual([]);
		expect(await getOpenProjectIntakeForHome(db)).toBeNull();
	});
});

describe('completeProjectIntakeAfterProvisioning', () => {
	it('posts a setup-complete comment and moves the intake to Done', async () => {
		const created = await createProjectIntake(db, {
			name: 'Ship It',
			description: 'desc',
			initialProjectPlan: null,
		});

		const { summaryComment, task } = await completeProjectIntakeAfterProvisioning(
			db,
			created!.intakeTaskId,
			'Ship It',
			'ship-it',
		);

		expect(task).not.toBeNull();
		expect((task as { status: string }).status).toBe(TaskStatus.Done);
		expect(summaryComment).not.toBeNull();
		expect((summaryComment!.content as { text: string }).text).toContain('Setup complete');
		expect((summaryComment!.content as { text: string }).text).toContain('ship-it');

		// The intake task is terminal in the DB.
		const row = await db.query<{ status: string }>(
			`SELECT status::text AS status FROM tasks WHERE id = $1`,
			[created!.intakeTaskId],
		);
		expect(row.rows[0].status).toBe(TaskStatus.Done);

		// A status-change system comment was recorded (recordStatusChange).
		const sys = await db.query<{ c: number }>(
			`SELECT count(*)::int AS c FROM task_comments
			 WHERE task_id = $1 AND content_type = 'system'::comment_content_type`,
			[created!.intakeTaskId],
		);
		expect(sys.rows[0].c).toBeGreaterThan(0);
	});

	it('is a no-op when the intake is already terminal (idempotent)', async () => {
		const created = await createProjectIntake(db, {
			name: 'Already Closed',
			description: 'desc',
			initialProjectPlan: null,
		});
		await db.query(`UPDATE tasks SET status = $1::task_status WHERE id = $2`, [
			TaskStatus.Cancelled,
			created!.intakeTaskId,
		]);

		const { summaryComment, task } = await completeProjectIntakeAfterProvisioning(
			db,
			created!.intakeTaskId,
			'Already Closed',
			'already-closed',
		);
		expect(summaryComment).toBeNull();
		expect(task).toBeNull();

		// Status stays Cancelled — not flipped to Done.
		const row = await db.query<{ status: string }>(
			`SELECT status::text AS status FROM tasks WHERE id = $1`,
			[created!.intakeTaskId],
		);
		expect(row.rows[0].status).toBe(TaskStatus.Cancelled);
	});

	it('is a no-op for an unknown task id', async () => {
		const { summaryComment, task } = await completeProjectIntakeAfterProvisioning(
			db,
			'00000000-0000-0000-0000-000000000000',
			'Ghost',
			'ghost',
		);
		expect(summaryComment).toBeNull();
		expect(task).toBeNull();
	});
});
