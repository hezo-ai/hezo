import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { beforeAll, describe, expect, it } from 'vitest';
import { safeClose } from './helpers';

// 013_remove_options_comment.sql drops the `options` comment type and the
// `option_chosen` wakeup source by recreating each enum without the value.
// Rows carrying the removed value are deleted first; everything else — including
// the shared `chosen_option` column on credential_request / action comments and
// every other wakeup source — must survive untouched. This drives the REAL
// migration files through the apply-in-order path (001 -> ... -> 013) against
// populated data and asserts the deletion + preservation, then proves the
// removed enum values no longer accept inserts.

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

const PRE_REMOVAL_MIGRATIONS = [
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
];

describe('013_remove_options_comment migration', () => {
	let db: PGlite;
	let teamId: string;
	let memberId: string;
	let optionsCommentId: string;
	let textCommentId: string;
	let credentialCommentId: string;
	let actionCommentId: string;
	let optionChosenWakeupId: string;
	let mentionWakeupId: string;

	beforeAll(async () => {
		db = new PGlite({ extensions: { vector } });
		for (const file of PRE_REMOVAL_MIGRATIONS) await db.exec(loadMigration(file));

		// Sanity: both removed values exist on the pre-013 schema.
		const before = await db.query<{ enumlabel: string }>(
			`SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
			 WHERE t.typname = 'comment_content_type' AND e.enumlabel = 'options'`,
		);
		expect(before.rows.length).toBe(1);

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

		async function insertComment(
			contentType: string,
			content: object,
			chosen: object | null,
		): Promise<string> {
			const r = await db.query<{ id: string }>(
				`INSERT INTO task_comments (task_id, content_type, content, chosen_option)
				 VALUES ($1, $2::comment_content_type, $3::jsonb, $4::jsonb) RETURNING id`,
				[taskId, contentType, JSON.stringify(content), chosen ? JSON.stringify(chosen) : null],
			);
			return r.rows[0].id;
		}

		// An options comment (to be deleted) plus comments of types that stay —
		// including two that keep using the shared chosen_option column.
		optionsCommentId = await insertComment(
			'options',
			{ prompt: 'Which?', options: [{ id: 'a', label: 'A' }] },
			{ chosen_id: 'a' },
		);
		textCommentId = await insertComment('text', { text: 'hello' }, null);
		credentialCommentId = await insertComment(
			'credential_request',
			{ name: 'API_KEY' },
			{ secret_id: 'sec-123' },
		);
		actionCommentId = await insertComment(
			'action',
			{ kind: 'setup_repo' },
			{ status: 'complete', result: { repo_id: 'r1' } },
		);

		async function insertWakeup(source: string): Promise<string> {
			const r = await db.query<{ id: string }>(
				`INSERT INTO agent_wakeup_requests (member_id, team_id, source)
				 VALUES ($1, $2, $3::wakeup_source) RETURNING id`,
				[memberId, teamId, source],
			);
			return r.rows[0].id;
		}
		optionChosenWakeupId = await insertWakeup('option_chosen');
		mentionWakeupId = await insertWakeup('mention');

		// The actual upgrade step.
		await db.exec(loadMigration('013_remove_options_comment.sql'));
	});

	it('drops the options value from comment_content_type', async () => {
		const r = await db.query<{ enumlabel: string }>(
			`SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
			 WHERE t.typname = 'comment_content_type' ORDER BY enumlabel`,
		);
		const labels = r.rows.map((x) => x.enumlabel);
		expect(labels).not.toContain('options');
		// The other types survive.
		expect(labels).toEqual(
			expect.arrayContaining([
				'text',
				'preview',
				'trace',
				'system',
				'run',
				'action',
				'credential_request',
				'connect_required',
			]),
		);
	});

	it('drops the option_chosen value from wakeup_source', async () => {
		const r = await db.query<{ enumlabel: string }>(
			`SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
			 WHERE t.typname = 'wakeup_source'`,
		);
		const labels = r.rows.map((x) => x.enumlabel);
		expect(labels).not.toContain('option_chosen');
		expect(labels).toEqual(
			expect.arrayContaining(['mention', 'credential_provided', 'assignment', 'heartbeat']),
		);
	});

	it('deletes the options comment but preserves every other comment type', async () => {
		const gone = await db.query(`SELECT id FROM task_comments WHERE id = $1`, [optionsCommentId]);
		expect(gone.rows.length).toBe(0);

		const kept = await db.query<{ id: string }>(
			`SELECT id FROM task_comments WHERE id = ANY($1::uuid[])`,
			[[textCommentId, credentialCommentId, actionCommentId]],
		);
		expect(kept.rows.length).toBe(3);
	});

	it('preserves the shared chosen_option payloads on credential_request and action comments', async () => {
		const cred = await db.query<{ chosen_option: { secret_id?: string } }>(
			`SELECT chosen_option FROM task_comments WHERE id = $1`,
			[credentialCommentId],
		);
		expect(cred.rows[0].chosen_option?.secret_id).toBe('sec-123');

		const action = await db.query<{ chosen_option: { status?: string } }>(
			`SELECT chosen_option FROM task_comments WHERE id = $1`,
			[actionCommentId],
		);
		expect(action.rows[0].chosen_option?.status).toBe('complete');
	});

	it('deletes option_chosen wakeups but preserves the others', async () => {
		const gone = await db.query(`SELECT id FROM agent_wakeup_requests WHERE id = $1`, [
			optionChosenWakeupId,
		]);
		expect(gone.rows.length).toBe(0);

		const kept = await db.query(`SELECT id FROM agent_wakeup_requests WHERE id = $1`, [
			mentionWakeupId,
		]);
		expect(kept.rows.length).toBe(1);
	});

	it('rejects inserting the removed enum values after the migration', async () => {
		const task = await db.query<{ id: string }>(`SELECT id FROM tasks LIMIT 1`);
		await expect(
			db.query(
				`INSERT INTO task_comments (task_id, content_type, content)
				 VALUES ($1, 'options'::comment_content_type, '{}'::jsonb)`,
				[task.rows[0].id],
			),
		).rejects.toThrow();
		await expect(
			db.query(
				`INSERT INTO agent_wakeup_requests (member_id, team_id, source)
				 VALUES ($1, $2, 'option_chosen'::wakeup_source)`,
				[memberId, teamId],
			),
		).rejects.toThrow();
	});

	it('cleans up', async () => {
		await safeClose(db);
	});
});
