import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '021_generalize_chat_schema.sql';

// Seeds the CEO-named chat tables at schema 020, applies the generalize migration,
// and asserts (a) the tables/enums now read under generic `chat_*` names, (b) the
// seeded rows survived, and (c) the agent-scoping backfills populated
// `chat_conversations.project_id` (HQ project) and `chat_messages.author_member_id`
// (the agent, for the assistant row; NULL for the user row).
describe('021_generalize_chat_schema migration', () => {
	let h: DataPreservationHarness;
	let ceoMemberId: string;
	let projectId: string;
	let conversationId: string;
	let sessionId: string;
	let userMessageId: string;
	let assistantMessageId: string;

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
		projectId = project.rows[0].id;

		const member = await h.db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, 'agent', 'CEO') RETURNING id`,
			[teamId],
		);
		ceoMemberId = member.rows[0].id;
		await h.db.query(`INSERT INTO member_agents (id, title, slug) VALUES ($1, 'CEO', 'ceo')`, [
			ceoMemberId,
		]);

		// Seed at the CEO-named (pre-021) schema.
		const session = await h.db.query<{ id: string }>(
			`INSERT INTO ceo_sessions (member_id, team_id, project_id, runtime_type, status)
			 VALUES ($1, $2, $3, 'claude_code', 'running') RETURNING id`,
			[ceoMemberId, teamId, projectId],
		);
		sessionId = session.rows[0].id;

		const convo = await h.db.query<{ id: string }>(
			`INSERT INTO ceo_conversations (member_id, team_id) VALUES ($1, $2) RETURNING id`,
			[ceoMemberId, teamId],
		);
		conversationId = convo.rows[0].id;

		const userMsg = await h.db.query<{ id: string }>(
			`INSERT INTO ceo_messages (conversation_id, role, channel, status, content, author_user_id)
			 VALUES ($1, 'user', 'web', 'complete', 'hi there', NULL) RETURNING id`,
			[conversationId],
		);
		userMessageId = userMsg.rows[0].id;
		const assistantMsg = await h.db.query<{ id: string }>(
			`INSERT INTO ceo_messages (conversation_id, role, channel, status, content, session_id)
			 VALUES ($1, 'assistant', 'web', 'complete', 'hello', $2) RETURNING id`,
			[conversationId, sessionId],
		);
		assistantMessageId = assistantMsg.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('renames the tables to generic chat_* names (old names gone)', async () => {
		const present = await h.db.query<{ table_name: string }>(
			`SELECT table_name FROM information_schema.tables
			 WHERE table_name IN ('chat_sessions', 'chat_conversations', 'chat_messages')`,
		);
		expect(present.rows.map((r) => r.table_name).sort()).toEqual([
			'chat_conversations',
			'chat_messages',
			'chat_sessions',
		]);
		const old = await h.db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM information_schema.tables
			 WHERE table_name IN ('ceo_sessions', 'ceo_conversations', 'ceo_messages')`,
		);
		expect(old.rows[0].c).toBe(0);
	});

	it('renames the enum types to chat_*', async () => {
		const types = await h.db.query<{ typname: string }>(
			`SELECT typname FROM pg_type
			 WHERE typname IN ('chat_channel', 'chat_message_role', 'chat_message_status', 'chat_session_status')`,
		);
		expect(types.rows.length).toBe(4);
	});

	it('preserves the seeded conversation, session, and messages', async () => {
		const convo = await h.db.query(`SELECT 1 FROM chat_conversations WHERE id = $1`, [
			conversationId,
		]);
		expect(convo.rows.length).toBe(1);
		const session = await h.db.query(`SELECT 1 FROM chat_sessions WHERE id = $1`, [sessionId]);
		expect(session.rows.length).toBe(1);
		const msgs = await h.db.query<{ content: string }>(
			`SELECT content FROM chat_messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
			[conversationId],
		);
		expect(msgs.rows.map((r) => r.content)).toEqual(['hi there', 'hello']);
	});

	it('backfills chat_conversations.project_id to the HQ project', async () => {
		const c = await h.db.query<{ project_id: string }>(
			`SELECT project_id FROM chat_conversations WHERE id = $1`,
			[conversationId],
		);
		expect(c.rows[0].project_id).toBe(projectId);
	});

	it('backfills chat_messages.author_member_id for the assistant row only', async () => {
		const assistant = await h.db.query<{ author_member_id: string | null }>(
			`SELECT author_member_id FROM chat_messages WHERE id = $1`,
			[assistantMessageId],
		);
		expect(assistant.rows[0].author_member_id).toBe(ceoMemberId);
		const user = await h.db.query<{ author_member_id: string | null }>(
			`SELECT author_member_id FROM chat_messages WHERE id = $1`,
			[userMessageId],
		);
		expect(user.rows[0].author_member_id).toBeNull();
	});
});
