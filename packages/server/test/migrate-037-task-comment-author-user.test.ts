import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '037_task_comment_author_user.sql';

describe('037_task_comment_author_user migration', () => {
	let h: DataPreservationHarness;
	let superuserId: string;
	let taskId: string;
	let agentMemberId: string;
	let humanCommentId: string;
	let agentCommentId: string;
	let systemCommentId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		// A single superuser (the single-admin instance the backfill targets).
		const su = await h.db.query<{ id: string }>(
			`INSERT INTO users (display_name, is_superuser) VALUES ('Admin', true) RETURNING id`,
		);
		superuserId = su.rows[0].id;

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		const teamId = team.rows[0].id;
		const project = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix)
			 VALUES ($1, 'Main', 'main', 'MA') RETURNING id`,
			[teamId],
		);
		const agentMember = await h.db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, 'agent', 'Bot') RETURNING id`,
			[teamId],
		);
		agentMemberId = agentMember.rows[0].id;
		const task = await h.db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title, status, priority, labels)
			 VALUES ($1, $2, 1, 'MA-1', 'Seeded', 'backlog', 'medium', '{}') RETURNING id`,
			[teamId, project.rows[0].id],
		);
		taskId = task.rows[0].id;

		// A human admin text comment (no author id — the case the migration backfills).
		const human = await h.db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, content_type, content)
			 VALUES ($1, 'text'::comment_content_type, '{"text":"from the admin"}'::jsonb) RETURNING id`,
			[taskId],
		);
		humanCommentId = human.rows[0].id;

		// An agent text comment (attributed by author_member_id — must not be backfilled).
		const agent = await h.db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, $2, 'text'::comment_content_type, '{"text":"from the bot"}'::jsonb) RETURNING id`,
			[taskId, agentMemberId],
		);
		agentCommentId = agent.rows[0].id;

		// A system comment (non-text, no author — must not be backfilled).
		const system = await h.db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, content_type, content)
			 VALUES ($1, 'system'::comment_content_type, '{"text":"status changed"}'::jsonb) RETURNING id`,
			[taskId],
		);
		systemCommentId = system.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('adds the author_user_id column referencing users', async () => {
		const col = await h.db.query<{ column_name: string }>(
			`SELECT column_name FROM information_schema.columns
			 WHERE table_name = 'task_comments' AND column_name = 'author_user_id'`,
		);
		expect(col.rows.length).toBe(1);
	});

	it('backfills the human admin text comment to the sole superuser', async () => {
		const r = await h.db.query<{ author_user_id: string | null }>(
			`SELECT author_user_id FROM task_comments WHERE id = $1`,
			[humanCommentId],
		);
		expect(r.rows[0].author_user_id).toBe(superuserId);
	});

	it('leaves agent- and system-authored comments unattributed to a user', async () => {
		const agent = await h.db.query<{ author_user_id: string | null }>(
			`SELECT author_user_id FROM task_comments WHERE id = $1`,
			[agentCommentId],
		);
		expect(agent.rows[0].author_user_id).toBeNull();
		const system = await h.db.query<{ author_user_id: string | null }>(
			`SELECT author_user_id FROM task_comments WHERE id = $1`,
			[systemCommentId],
		);
		expect(system.rows[0].author_user_id).toBeNull();
	});

	it('preserves pre-existing comment content', async () => {
		const r = await h.db.query<{ content: { text: string }; content_type: string }>(
			`SELECT content, content_type FROM task_comments WHERE id = $1`,
			[humanCommentId],
		);
		expect(r.rows.length).toBe(1);
		expect(r.rows[0].content_type).toBe('text');
		expect(r.rows[0].content.text).toBe('from the admin');
	});

	it('nulls author_user_id when the user is removed (ON DELETE SET NULL)', async () => {
		await h.db.query(`DELETE FROM users WHERE id = $1`, [superuserId]);
		const r = await h.db.query<{ author_user_id: string | null }>(
			`SELECT author_user_id FROM task_comments WHERE id = $1`,
			[humanCommentId],
		);
		expect(r.rows.length).toBe(1);
		expect(r.rows[0].author_user_id).toBeNull();
	});
});
