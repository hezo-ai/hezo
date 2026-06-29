import type { PGlite } from '@electric-sql/pglite';
import { CEO_AGENT_SLUG, TaskStatus } from '@hezo/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
	completeProjectIntakeAfterProvisioning,
	createProjectIntake,
	getOpenProjectIntakeForHome,
} from '../src/services/project-intake';
import { safeClose } from './helpers';
import { createTestApp } from './helpers/app';

let db: PGlite;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
});

afterAll(async () => {
	await safeClose(db);
});

beforeEach(async () => {
	await db.query(`DELETE FROM task_comments WHERE task_id IN
		(SELECT id FROM tasks WHERE labels @> '["project-intake"]'::jsonb)`);
	await db.query(`DELETE FROM tasks WHERE labels @> '["project-intake"]'::jsonb`);
	await db.query('DELETE FROM agent_wakeup_requests');
});

describe('createProjectIntake — greeting / baseline branches', () => {
	it('omits the suggested-team-type line and the plan-attachment hint when neither is given', async () => {
		const result = await createProjectIntake(db, {
			name: 'Bare Intake',
			description: 'no extras',
			initialProjectPlan: null,
		});
		expect(result).not.toBeNull();

		// Only the greeting comment — no second plan-attachment comment.
		const comments = await db.query<{ content: { text: string } }>(
			`SELECT content FROM task_comments WHERE task_id = $1 ORDER BY created_at ASC`,
			[result!.intakeTaskId],
		);
		expect(comments.rows.length).toBe(1);
		const greeting = comments.rows[0].content.text;
		expect(greeting).toContain("I'm the CEO");
		// No baselineTeamTypeName -> no "Suggested team type" line.
		expect(greeting).not.toContain('Suggested team type');
		// No plan -> no "I'll attach your project plan" hint.
		expect(greeting).not.toContain("I'll attach your project plan");

		// Default baseline line (no template, no source team) => Blank.
		const task = await db.query<{ description: string }>(
			`SELECT description FROM tasks WHERE id = $1`,
			[result!.intakeTaskId],
		);
		expect(task.rows[0].description).toContain('Blank (Captain only)');
		expect(task.rows[0].description).toContain('Has project plan doc:** no');
	});

	it('renders the template baseline line when only a templateId is supplied (no name)', async () => {
		const result = await createProjectIntake(db, {
			name: 'Template Intake',
			description: 'desc',
			initialProjectPlan: null,
			baselineTemplateId: '22222222-2222-2222-2222-222222222222',
		});
		const task = await db.query<{ description: string }>(
			`SELECT description FROM tasks WHERE id = $1`,
			[result!.intakeTaskId],
		);
		// Falls back to the literal "template" label when no team-type name is present.
		expect(task.rows[0].description).toContain('Baseline team type:** template');
		expect(task.rows[0].description).toContain('22222222-2222-2222-2222-222222222222');
	});

	it('renders the suggested-team-type line in the greeting when a name is supplied', async () => {
		const result = await createProjectIntake(db, {
			name: 'Named Type Intake',
			description: 'desc',
			initialProjectPlan: null,
			baselineTeamTypeName: 'Growth Team',
		});
		const comments = await db.query<{ content: { text: string } }>(
			`SELECT content FROM task_comments WHERE task_id = $1 ORDER BY created_at ASC`,
			[result!.intakeTaskId],
		);
		expect(comments.rows[0].content.text).toContain('Suggested team type:** Growth Team');
	});
});

describe('createProjectIntake — missing coordination context', () => {
	it('returns null when there is no CEO / HQ project', async () => {
		// Disable the CEO so loadCoordinationContext resolves to null.
		await db.query(
			`UPDATE member_agents SET admin_status = 'disabled'::agent_admin_status WHERE slug = $1`,
			[CEO_AGENT_SLUG],
		);
		try {
			const result = await createProjectIntake(db, {
				name: 'No CEO',
				description: 'desc',
				initialProjectPlan: null,
			});
			expect(result).toBeNull();
		} finally {
			await db.query(
				`UPDATE member_agents SET admin_status = 'enabled'::agent_admin_status WHERE slug = $1`,
				[CEO_AGENT_SLUG],
			);
		}
	});
});

describe('getOpenProjectIntakeForHome — extractCommentText branches', () => {
	it('extracts greeting text from a JSON-string-encoded comment content', async () => {
		const created = await createProjectIntake(db, {
			name: 'Object Content',
			description: 'desc',
			initialProjectPlan: null,
		});
		// The first comment is stored as a jsonb object {text: ...}; force a
		// string-encoded JSON variant to exercise the string-parse branch.
		await db.query(
			`UPDATE task_comments SET content = to_jsonb($1::text)
			 WHERE task_id = $2 AND content_type = 'text'::comment_content_type`,
			[JSON.stringify({ text: 'string-encoded greeting' }), created!.intakeTaskId],
		);
		const home = await getOpenProjectIntakeForHome(db);
		expect(home).not.toBeNull();
		expect(home!.greeting).toBe('string-encoded greeting');
	});

	it('falls back to the raw string when the comment content is non-JSON text', async () => {
		const created = await createProjectIntake(db, {
			name: 'Raw String',
			description: 'desc',
			initialProjectPlan: null,
		});
		await db.query(
			`UPDATE task_comments SET content = to_jsonb($1::text)
			 WHERE task_id = $2 AND content_type = 'text'::comment_content_type`,
			['not json at all', created!.intakeTaskId],
		);
		const home = await getOpenProjectIntakeForHome(db);
		expect(home!.greeting).toBe('not json at all');
	});

	it('yields empty greeting when the object content has no text field', async () => {
		const created = await createProjectIntake(db, {
			name: 'No Text Field',
			description: 'desc',
			initialProjectPlan: null,
		});
		await db.query(
			`UPDATE task_comments SET content = '{"other":"value"}'::jsonb
			 WHERE task_id = $1 AND content_type = 'text'::comment_content_type`,
			[created!.intakeTaskId],
		);
		const home = await getOpenProjectIntakeForHome(db);
		expect(home!.greeting).toBe('');
	});
});

describe('completeProjectIntakeAfterProvisioning — missing context', () => {
	it('returns nulls when the CEO / HQ project is missing', async () => {
		const created = await createProjectIntake(db, {
			name: 'Will Lose CEO',
			description: 'desc',
			initialProjectPlan: null,
		});
		await db.query(
			`UPDATE member_agents SET admin_status = 'disabled'::agent_admin_status WHERE slug = $1`,
			[CEO_AGENT_SLUG],
		);
		try {
			const { summaryComment, task } = await completeProjectIntakeAfterProvisioning(
				db,
				created!.intakeTaskId,
				'Will Lose CEO',
				'will-lose-ceo',
			);
			expect(summaryComment).toBeNull();
			expect(task).toBeNull();
			// Task stays in its original (non-terminal) status.
			const row = await db.query<{ status: string }>(
				`SELECT status::text AS status FROM tasks WHERE id = $1`,
				[created!.intakeTaskId],
			);
			expect(row.rows[0].status).toBe(TaskStatus.InProgress);
		} finally {
			await db.query(
				`UPDATE member_agents SET admin_status = 'enabled'::agent_admin_status WHERE slug = $1`,
				[CEO_AGENT_SLUG],
			);
		}
	});
});
