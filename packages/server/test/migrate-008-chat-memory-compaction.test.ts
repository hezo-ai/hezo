import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '008_chat_memory_compaction.sql';

describe('008_chat_memory_compaction migration', () => {
	let h: DataPreservationHarness;
	let ceoMemberId: string;
	let conversationId: string;
	let messageId: string;
	let keptDocId: string;

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

		// CEO agent member.
		const member = await h.db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, 'agent', 'CEO') RETURNING id`,
			[teamId],
		);
		ceoMemberId = member.rows[0].id;
		await h.db.query(`INSERT INTO member_agents (id, title, slug) VALUES ($1, 'CEO', 'ceo')`, [
			ceoMemberId,
		]);

		// The chat-memory.md doc that must be carried forward then removed.
		await h.db.query(
			`INSERT INTO documents (project_id, team_id, type, slug, title, content)
			 VALUES ($1, $2, 'project_doc', 'chat-memory.md', 'Chatbox memory', 'operator prefers terse replies')`,
			[projectId, teamId],
		);
		// An unrelated project doc that must survive untouched.
		const kept = await h.db.query<{ id: string }>(
			`INSERT INTO documents (project_id, team_id, type, slug, title, content)
			 VALUES ($1, $2, 'project_doc', 'prd.md', 'PRD', 'the plan') RETURNING id`,
			[projectId, teamId],
		);
		keptDocId = kept.rows[0].id;

		// A conversation + message that must survive and pick up compacted_at = NULL.
		const convo = await h.db.query<{ id: string }>(
			`INSERT INTO ceo_conversations (member_id, team_id) VALUES ($1, $2) RETURNING id`,
			[ceoMemberId, teamId],
		);
		conversationId = convo.rows[0].id;
		const msg = await h.db.query<{ id: string }>(
			`INSERT INTO ceo_messages (conversation_id, role, channel, status, content)
			 VALUES ($1, 'user', 'web', 'complete', 'hi there') RETURNING id`,
			[conversationId],
		);
		messageId = msg.rows[0].id;

		// A stale message-count setting that the migration should clear.
		await h.db.query(`INSERT INTO system_meta (key, value) VALUES ('chat_history_limit', '80')`);

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('creates chat_memories and the ceo_messages.compacted_at column', async () => {
		const tbl = await h.db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM information_schema.tables WHERE table_name = 'chat_memories'`,
		);
		expect(tbl.rows[0].c).toBe(1);
		const col = await h.db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM information_schema.columns
			 WHERE table_name = 'ceo_messages' AND column_name = 'compacted_at'`,
		);
		expect(col.rows[0].c).toBe(1);
	});

	it('carries the chat-memory.md content into the CEO long-term memory', async () => {
		const mem = await h.db.query<{ content: string }>(
			`SELECT content FROM chat_memories WHERE member_id = $1`,
			[ceoMemberId],
		);
		expect(mem.rows.length).toBe(1);
		expect(mem.rows[0].content).toBe('operator prefers terse replies');
	});

	it('removes the chat-memory.md doc but preserves other docs', async () => {
		const gone = await h.db.query(`SELECT 1 FROM documents WHERE slug = 'chat-memory.md'`);
		expect(gone.rows.length).toBe(0);
		const kept = await h.db.query(`SELECT 1 FROM documents WHERE id = $1`, [keptDocId]);
		expect(kept.rows.length).toBe(1);
	});

	it('preserves the pre-existing message with a NULL compacted_at', async () => {
		const m = await h.db.query<{ id: string; compacted_at: string | null }>(
			`SELECT id, compacted_at FROM ceo_messages WHERE id = $1`,
			[messageId],
		);
		expect(m.rows.length).toBe(1);
		expect(m.rows[0].compacted_at).toBeNull();
	});

	it('clears the obsolete chat_history_limit setting', async () => {
		const s = await h.db.query(`SELECT 1 FROM system_meta WHERE key = 'chat_history_limit'`);
		expect(s.rows.length).toBe(0);
	});

	it('can mark a message compacted after the migration', async () => {
		await h.db.query(`UPDATE ceo_messages SET compacted_at = now() WHERE id = $1`, [messageId]);
		const m = await h.db.query<{ compacted_at: string | null }>(
			`SELECT compacted_at FROM ceo_messages WHERE id = $1`,
			[messageId],
		);
		expect(m.rows[0].compacted_at).not.toBeNull();
	});
});
