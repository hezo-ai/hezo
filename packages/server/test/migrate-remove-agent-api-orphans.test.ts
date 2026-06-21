import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { beforeAll, describe, expect, it } from 'vitest';
import { safeClose } from './helpers';

// 017_remove_agent_api_orphans.sql removes structures left behind when the
// /agent-api surface was deleted: the `tool_calls` table (+ `tool_call_status`
// enum), the `trace` comment content_type, and the `secret_access` approval type.
// Rows carrying a removed enum value are deleted first; everything else must
// survive. This drives the REAL migration files in order (001 -> ... -> 017)
// against populated data and asserts the deletion + preservation, then proves the
// removed values/table no longer accept inserts.

function migrationsDir(): string {
	try {
		return fileURLToPath(new URL('../migrations', import.meta.url));
	} catch {
		const override = process.env.HEZO_MIGRATIONS_DIR;
		if (!override) throw new Error('HEZO_MIGRATIONS_DIR unset and import.meta.url not a file URL');
		return override;
	}
}

function loadMigration(file: string): string {
	return readFileSync(join(migrationsDir(), file), 'utf-8').replace(
		/CREATE EXTENSION IF NOT EXISTS "pgcrypto";/g,
		'',
	);
}

const PRE_017_MIGRATIONS = [
	'001_initial_schema.sql',
	'002_migration_smoke.sql',
	'003_budgeting.sql',
	'004_cost_provider_tracking.sql',
	'005_model_pricing.sql',
	'006_budget_runtime_states.sql',
	'007_comment_public_id.sql',
	'008_opencode_kimi_runtimes.sql',
	'009_skills_builtin.sql',
	'010_heartbeat_run_produced_output.sql',
	'011_heartbeat_run_no_work.sql',
	'012_drop_skills_builtin.sql',
	'013_remove_options_comment.sql',
	'014_comments_embedding.sql',
	'015_heartbeat_run_usage_partial.sql',
	'016_connected_agents.sql',
];

describe('017_remove_agent_api_orphans migration', () => {
	let db: PGlite;
	let teamId: string;
	let memberId: string;
	let traceCommentId: string;
	let textCommentId: string;
	let secretApprovalId: string;
	let hireApprovalId: string;

	beforeAll(async () => {
		db = new PGlite({ extensions: { vector } });
		for (const file of PRE_017_MIGRATIONS) await db.exec(loadMigration(file));

		// Sanity: the orphans exist on the pre-017 schema.
		const before = await db.query<{ enumlabel: string }>(
			`SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
			 WHERE (t.typname = 'comment_content_type' AND e.enumlabel = 'trace')
			    OR (t.typname = 'approval_type' AND e.enumlabel = 'secret_access')`,
		);
		expect(before.rows.length).toBe(2);

		const team = await db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		teamId = team.rows[0].id;
		const project = await db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix) VALUES ($1, 'Ops', 'ops', 'OPS') RETURNING id`,
			[teamId],
		);
		const projectId = project.rows[0].id;
		const member = await db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name) VALUES ($1, 'user', 'Admin') RETURNING id`,
			[teamId],
		);
		memberId = member.rows[0].id;
		const task = await db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title)
			 VALUES ($1, $2, 1, 'OPS-1', 'Task') RETURNING id`,
			[teamId, projectId],
		);
		const taskId = task.rows[0].id;

		async function insertComment(contentType: string): Promise<string> {
			const r = await db.query<{ id: string }>(
				`INSERT INTO task_comments (task_id, content_type, content)
				 VALUES ($1, $2::comment_content_type, '{}'::jsonb) RETURNING id`,
				[taskId, contentType],
			);
			return r.rows[0].id;
		}
		// A trace comment (to be deleted) + a tool_calls row hanging off it, plus a
		// text comment that must survive.
		traceCommentId = await insertComment('trace');
		textCommentId = await insertComment('text');
		await db.query(
			`INSERT INTO tool_calls (comment_id, member_id, tool_name) VALUES ($1, $2, 'grep')`,
			[traceCommentId, memberId],
		);

		async function insertApproval(type: string): Promise<string> {
			const r = await db.query<{ id: string }>(
				`INSERT INTO approvals (team_id, type, payload)
				 VALUES ($1, $2::approval_type, '{}'::jsonb) RETURNING id`,
				[teamId, type],
			);
			return r.rows[0].id;
		}
		// A secret_access approval (to be deleted) + a hire approval that survives.
		secretApprovalId = await insertApproval('secret_access');
		hireApprovalId = await insertApproval('hire');

		// The actual upgrade step.
		await db.exec(loadMigration('017_remove_agent_api_orphans.sql'));
	});

	it('drops the tool_calls table and the tool_call_status enum', async () => {
		await expect(db.query('SELECT 1 FROM tool_calls')).rejects.toThrow();
		const type = await db.query(`SELECT 1 FROM pg_type WHERE typname = 'tool_call_status'`);
		expect(type.rows.length).toBe(0);
	});

	it('drops the trace value from comment_content_type but keeps the rest', async () => {
		const r = await db.query<{ enumlabel: string }>(
			`SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
			 WHERE t.typname = 'comment_content_type'`,
		);
		const labels = r.rows.map((x) => x.enumlabel);
		expect(labels).not.toContain('trace');
		expect(labels).toEqual(
			expect.arrayContaining([
				'text',
				'preview',
				'system',
				'run',
				'action',
				'credential_request',
				'connect_required',
			]),
		);
	});

	it('drops the secret_access value from approval_type but keeps the rest', async () => {
		const r = await db.query<{ enumlabel: string }>(
			`SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
			 WHERE t.typname = 'approval_type'`,
		);
		const labels = r.rows.map((x) => x.enumlabel);
		expect(labels).not.toContain('secret_access');
		expect(labels).toEqual(
			expect.arrayContaining([
				'hire',
				'project_creation',
				'strategy',
				'plan_review',
				'deploy_production',
				'designated_repo_request',
				'skill_proposal',
			]),
		);
	});

	it('deletes the trace comment and secret_access approval but preserves siblings', async () => {
		const trace = await db.query('SELECT id FROM task_comments WHERE id = $1', [traceCommentId]);
		expect(trace.rows.length).toBe(0);
		const text = await db.query('SELECT id FROM task_comments WHERE id = $1', [textCommentId]);
		expect(text.rows.length).toBe(1);

		const secret = await db.query('SELECT id FROM approvals WHERE id = $1', [secretApprovalId]);
		expect(secret.rows.length).toBe(0);
		const hire = await db.query('SELECT id FROM approvals WHERE id = $1', [hireApprovalId]);
		expect(hire.rows.length).toBe(1);
	});

	it('rejects inserting the removed enum values after the migration', async () => {
		const task = await db.query<{ id: string }>(`SELECT id FROM tasks LIMIT 1`);
		await expect(
			db.query(
				`INSERT INTO task_comments (task_id, content_type, content)
				 VALUES ($1, 'trace'::comment_content_type, '{}'::jsonb)`,
				[task.rows[0].id],
			),
		).rejects.toThrow();
		await expect(
			db.query(
				`INSERT INTO approvals (team_id, type, payload)
				 VALUES ($1, 'secret_access'::approval_type, '{}'::jsonb)`,
				[teamId],
			),
		).rejects.toThrow();
	});

	it('cleans up', async () => {
		await safeClose(db);
	});
});
