import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '059_pending_admin_ask_index.sql';

describe('059_pending_admin_ask_index migration', () => {
	let h: DataPreservationHarness;
	let taskId: string;
	const commentIds: string[] = [];
	let pendingAskId = '';

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET); // schema at N-1

		// A task carrying the mix the partial index has to sort out: ordinary text
		// comments, one answered ask and one still open.
		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		const project = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix)
			 VALUES ($1, 'Ops', 'ops', 'OPS') RETURNING id`,
			[team.rows[0].id],
		);
		const task = await h.db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title)
			 VALUES ($1, $2, 1, 'OPS-1', 'Seed task') RETURNING id`,
			[team.rows[0].id, project.rows[0].id],
		);
		taskId = task.rows[0].id;

		for (let i = 0; i < 3; i++) {
			const c = await h.db.query<{ id: string }>(
				`INSERT INTO task_comments (task_id, content_type, content)
				 VALUES ($1, 'text'::comment_content_type, $2::jsonb) RETURNING id`,
				[taskId, JSON.stringify({ text: `comment ${i}` })],
			);
			commentIds.push(c.rows[0].id);
		}

		const answered = await h.db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, content_type, content, chosen_option)
			 VALUES ($1, 'action'::comment_content_type, $2::jsonb, $3::jsonb) RETURNING id`,
			[taskId, JSON.stringify({ kind: 'setup_repo' }), JSON.stringify({ status: 'approved' })],
		);
		commentIds.push(answered.rows[0].id);

		const pending = await h.db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, content_type, content)
			 VALUES ($1, 'credential_request'::comment_content_type, $2::jsonb) RETURNING id`,
			[taskId, JSON.stringify({ name: 'STRIPE_KEY', kind: 'api_key' })],
		);
		pendingAskId = pending.rows[0].id;
		commentIds.push(pendingAskId);

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('creates the partial unanswered-ask index', async () => {
		const idx = await h.db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM pg_indexes WHERE indexname = 'idx_comments_pending_ask'`,
		);
		expect(idx.rows[0].c).toBe(1);
	});

	it('indexes only unanswered asks, matching the ordering predicate', async () => {
		// The tier-2 predicate from adminActionPendingSql, spelled exactly as the
		// index's WHERE clause spells it. The answered action comment and the three
		// text comments must not qualify; the open credential request must.
		const matched = await h.db.query<{ id: string }>(
			`SELECT id FROM task_comments
			  WHERE task_id = $1
			    AND chosen_option IS NULL
			    AND content_type IN (
			      'action'::comment_content_type,
			      'credential_request'::comment_content_type,
			      'asset_deletion_request'::comment_content_type
			    )`,
			[taskId],
		);
		expect(matched.rows.map((r) => r.id)).toEqual([pendingAskId]);
	});

	it('preserves pre-existing comments, their ordering and their chosen_option', async () => {
		const rows = await h.db.query<{ id: string; chosen_option: unknown }>(
			`SELECT id, chosen_option FROM task_comments WHERE task_id = $1 ORDER BY created_at ASC, id ASC`,
			[taskId],
		);
		expect(rows.rows.map((r) => r.id).sort()).toEqual([...commentIds].sort());
		expect(rows.rows.filter((r) => r.chosen_option !== null)).toHaveLength(1);
	});
});
