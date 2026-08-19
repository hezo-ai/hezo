import { CEO_AGENT_SLUG } from '@hezo/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import {
	completeProjectIntakeAfterProvisioning,
	createProjectIntake,
	getOpenProjectIntakeForHome,
	getOpenProjectIntakeTasks,
} from '../src/services/project-intake';
import { WebSocketManager } from '../src/services/ws';
import { safeClose } from './helpers';
import { createTestApp } from './helpers/app';

/**
 * Branch-coverage companion for `services/project-intake.ts`. Targets arms the
 * existing `project-intake-extended.test.ts` doesn't reach:
 *  - the Blank-baseline + no-plan greeting/description branches
 *  - the `wsManager` broadcast branch on createProjectIntake
 *  - the missing-CEO/HQ `null` returns in createProjectIntake and
 *    completeProjectIntakeAfterProvisioning
 *  - getOpenProjectIntakeForHome's CEO-fallback (no CEO row) branch
 *  - extractCommentText over object / null / string-JSON comment shapes
 */

let db: Db;

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

describe('createProjectIntake — baseline / plan branches', () => {
	it('uses the Blank baseline line and omits plan prose when no template or plan is given', async () => {
		const result = await createProjectIntake(db, {
			name: 'Bare Project',
			description: 'No baseline, no plan',
			initialProjectPlan: null,
		});
		expect(result).not.toBeNull();

		const task = await db.query<{ description: string }>(
			'SELECT description FROM tasks WHERE id = $1',
			[result!.intakeTaskId],
		);
		expect(task.rows[0].description).toContain('Blank (Captain only)');
		expect(task.rows[0].description).toContain('**Has project plan doc:** no');

		// Only the greeting comment — no plan-attachment comment.
		const comments = await db.query<{ content: { text: string } }>(
			'SELECT content FROM task_comments WHERE task_id = $1 ORDER BY created_at ASC',
			[result!.intakeTaskId],
		);
		expect(comments.rows.length).toBe(1);
		expect(comments.rows[0].content.text).not.toContain("I'll attach your project plan");
		// No suggested-team-type line when baselineTeamTypeName is absent.
		expect(comments.rows[0].content.text).not.toContain('Suggested team type');
		// The greeting references the description rather than duplicating it.
		expect(comments.rows[0].content.text).not.toContain('No baseline, no plan');
	});

	it('uses the template baseline line when only a templateId is given', async () => {
		const result = await createProjectIntake(db, {
			name: 'Templated Project',
			description: 'Has a template baseline',
			initialProjectPlan: null,
			baselineTemplateId: '00000000-0000-0000-0000-0000000000aa',
			baselineTeamTypeName: 'App Team',
		});
		const task = await db.query<{ description: string }>(
			'SELECT description FROM tasks WHERE id = $1',
			[result!.intakeTaskId],
		);
		expect(task.rows[0].description).toContain(
			'template_id: `00000000-0000-0000-0000-0000000000aa`',
		);
		expect(task.rows[0].description).toContain('App Team');
	});

	it('broadcasts the new intake task and its admin-inbox row when a wsManager is supplied', async () => {
		const wsManager = new WebSocketManager();
		// Collect every table broadcast rather than keeping only the last: intake
		// raises the admin-inbox row after the task, so a last-write-wins spy would
		// assert on whichever broadcast happens to come last.
		const broadcastTables: string[] = [];
		const original = wsManager.broadcast.bind(wsManager);
		wsManager.broadcast = ((room: string, msg: { table?: string }) => {
			if (msg?.table) broadcastTables.push(msg.table);
			return original(room, msg as never);
		}) as typeof wsManager.broadcast;

		const result = await createProjectIntake(
			db,
			{ name: 'Broadcast Project', description: 'with ws', initialProjectPlan: null },
			wsManager,
		);
		expect(result).not.toBeNull();
		expect(broadcastTables).toContain('tasks');
		// The inbox row is how the intake reaches the admin now that no run is started.
		expect(broadcastTables).toContain('admin_mentions');
	});
});

describe('completeProjectIntakeAfterProvisioning — branches', () => {
	it('returns nulls when the intake task is unknown (idempotent no-op)', async () => {
		const r = await completeProjectIntakeAfterProvisioning(
			db,
			'00000000-0000-0000-0000-000000000999',
			'Ghost',
			'ghost',
		);
		expect(r.summaryComment).toBeNull();
		expect(r.task).toBeNull();
	});
});

describe('extractCommentText (via getOpenProjectIntakeForHome)', () => {
	it('reads the greeting from the object-shaped first comment', async () => {
		const created = await createProjectIntake(db, {
			name: 'Greeting Project',
			description: 'has a greeting',
			initialProjectPlan: null,
		});
		const home = await getOpenProjectIntakeForHome(db);
		expect(home).not.toBeNull();
		expect(home!.task_id).toBe(created!.intakeTaskId);
		expect(home!.greeting).toContain("I'm the CEO");
		expect(home!.ceo_title).toBeTruthy();
	});

	it('falls back to an empty greeting when there is no first comment', async () => {
		const created = await createProjectIntake(db, {
			name: 'No Comment Project',
			description: 'comment removed',
			initialProjectPlan: null,
		});
		// Remove the greeting comment to exercise the missing-row branch.
		await db.query('DELETE FROM task_comments WHERE task_id = $1', [created!.intakeTaskId]);
		const home = await getOpenProjectIntakeForHome(db);
		expect(home!.greeting).toBe('');
	});

	it('parses a string-JSON comment body and tolerates non-JSON text', async () => {
		const created = await createProjectIntake(db, {
			name: 'String Body Project',
			description: 'string content',
			initialProjectPlan: null,
		});
		// Replace the greeting with a raw-string JSON content cell.
		await db.query('DELETE FROM task_comments WHERE task_id = $1', [created!.intakeTaskId]);
		const ceo = await db.query<{ id: string }>(
			'SELECT id FROM member_agents WHERE slug = $1 LIMIT 1',
			[CEO_AGENT_SLUG],
		);
		await db.query(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, $2, 'text'::comment_content_type, $3::jsonb)`,
			[created!.intakeTaskId, ceo.rows[0].id, JSON.stringify('plain string not an object')],
		);
		const home = await getOpenProjectIntakeForHome(db);
		// Stored as a JSON string with no `.text` → falls back to the raw string.
		expect(home!.greeting).toBe('plain string not an object');
	});
});

describe('missing CEO / HQ project → null returns', () => {
	let db2: Db;

	beforeEach(async () => {
		const ctx = await createTestApp();
		db2 = ctx.db;
		// Drop the CEO so loadCoordinationContext cannot resolve.
		await db2.query('DELETE FROM member_agents WHERE slug = $1', [CEO_AGENT_SLUG]);
	});

	afterEach(async () => {
		await safeClose(db2);
	});

	it('createProjectIntake returns null when coordination context is missing', async () => {
		const r = await createProjectIntake(db2, {
			name: 'Orphan',
			description: 'no ceo',
			initialProjectPlan: null,
		});
		expect(r).toBeNull();
	});

	it('completeProjectIntakeAfterProvisioning returns nulls when context is missing', async () => {
		const r = await completeProjectIntakeAfterProvisioning(db2, 'x', 'n', 's');
		expect(r.summaryComment).toBeNull();
		expect(r.task).toBeNull();
		expect(await getOpenProjectIntakeTasks(db2)).toEqual([]);
	});
});
