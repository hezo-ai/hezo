import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '058_chat_system_message_kind.sql';

// Seeds a chat thread at schema 057 carrying all three message roles - including
// the convert-to-task system marker, which before this migration was the only
// system row a thread could hold - then applies the migration and asserts: the
// column exists, every pre-existing system row was backfilled to
// 'converted_task' (so it keeps rendering as the converted marker), non-system
// rows kept NULL, the CHECK rejects an unknown kind, and the composite comment
// index the chat's no-wake lookup needs is present. Message content and ordering
// must survive untouched.
describe('058_chat_system_message_kind migration', () => {
	let h: DataPreservationHarness;
	let userMessageId: string;
	let assistantMessageId: string;
	let systemMessageId: string;
	let conversationId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('HQ', 'hq-team') RETURNING id`,
		);
		const teamId = team.rows[0].id;
		const project = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix, is_internal)
			 VALUES ($1, 'HQ', 'hq', 'HQ', true) RETURNING id`,
			[teamId],
		);
		const projectId = project.rows[0].id;
		const member = await h.db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name) VALUES ($1, 'agent', 'CEO') RETURNING id`,
			[teamId],
		);
		const ceoId = member.rows[0].id;

		const convo = await h.db.query<{ id: string }>(
			`INSERT INTO chat_conversations (member_id, team_id, project_id, channel)
			 VALUES ($1, $2, $3, 'web') RETURNING id`,
			[ceoId, teamId, projectId],
		);
		conversationId = convo.rows[0].id;

		const insert = async (role: string, content: string): Promise<string> => {
			const r = await h.db.query<{ id: string }>(
				`INSERT INTO chat_messages (conversation_id, role, channel, status, content)
				 VALUES ($1, $2::chat_message_role, 'web', 'complete', $3) RETURNING id`,
				[conversationId, role, content],
			);
			return r.rows[0].id;
		};
		userMessageId = await insert('user', 'plan the launch');
		assistantMessageId = await insert('assistant', 'here is the plan');
		systemMessageId = await insert('system', 'Conversation converted to task HQ-4: Launch plan');

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('adds the system_kind column', async () => {
		const c = await h.db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM information_schema.columns
			 WHERE table_name = 'chat_messages' AND column_name = 'system_kind'`,
		);
		expect(c.rows[0].c).toBe(1);
	});

	it('backfills pre-existing system rows to converted_task and leaves others NULL', async () => {
		const rows = await h.db.query<{ id: string; role: string; system_kind: string | null }>(
			`SELECT id, role::text AS role, system_kind FROM chat_messages WHERE conversation_id = $1`,
			[conversationId],
		);
		const byId = new Map(rows.rows.map((r) => [r.id, r]));
		expect(byId.get(systemMessageId)?.system_kind).toBe('converted_task');
		expect(byId.get(userMessageId)?.system_kind).toBeNull();
		expect(byId.get(assistantMessageId)?.system_kind).toBeNull();
	});

	it('preserves the seeded messages, their content and their order', async () => {
		const rows = await h.db.query<{ id: string; content: string }>(
			`SELECT id, content FROM chat_messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
			[conversationId],
		);
		expect(rows.rows.map((r) => r.id)).toEqual([
			userMessageId,
			assistantMessageId,
			systemMessageId,
		]);
		expect(rows.rows[0].content).toBe('plan the launch');
		expect(rows.rows[2].content).toBe('Conversation converted to task HQ-4: Launch plan');
	});

	it('accepts the known kinds and rejects an unknown one', async () => {
		await expect(
			h.db.query(
				`INSERT INTO chat_messages (conversation_id, role, channel, status, content, system_kind)
				 VALUES ($1, 'system', 'web', 'complete', 'warning', 'handoff_not_delivered')`,
				[conversationId],
			),
		).resolves.toBeDefined();
		await expect(
			h.db.query(
				`INSERT INTO chat_messages (conversation_id, role, channel, status, content, system_kind)
				 VALUES ($1, 'system', 'web', 'complete', 'nope', 'not_a_kind')`,
				[conversationId],
			),
		).rejects.toThrow();
	});

	it('indexes the author + created_at lookup the chat no-wake check runs', async () => {
		const idx = await h.db.query<{ indexdef: string }>(
			`SELECT indexdef FROM pg_indexes
			 WHERE tablename = 'task_comments' AND indexname = 'idx_comments_author_created'`,
		);
		expect(idx.rows.length).toBe(1);
		expect(idx.rows[0].indexdef).toContain('author_member_id');
		expect(idx.rows[0].indexdef).toContain('created_at');
	});
});
