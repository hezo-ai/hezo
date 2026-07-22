import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '038_per_surface_chat_threads.sql';

// Seeds mirror-era data at schema 037 (a telegram-origin conversation with a
// bindings row, a message, a channel config), applies the de-mirroring
// migration, and asserts: 'slack'/'discord' joined the chat_channel enum and are
// usable, chat_conversations.kind exists defaulting pre-existing rows to
// 'assistant', chat_messages.author_label exists, the bindings table is GONE
// while the conversation row's own (channel, external_thread_id) routing key
// survived, and the observed-message buffer table exists.
describe('038_per_surface_chat_threads migration', () => {
	let h: DataPreservationHarness;
	let convoId: string;
	let messageId: string;

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
			`INSERT INTO chat_conversations (member_id, team_id, project_id, channel, external_thread_id)
			 VALUES ($1, $2, $3, 'telegram', '-100:7') RETURNING id`,
			[ceoId, teamId, projectId],
		);
		convoId = convo.rows[0].id;
		// Mirror-era binding row — the migration drops the whole table.
		await h.db.query(
			`INSERT INTO chat_conversation_bindings (conversation_id, channel, external_thread_id)
			 VALUES ($1, 'telegram', '-100:7')`,
			[convoId],
		);
		const msg = await h.db.query<{ id: string }>(
			`INSERT INTO chat_messages (conversation_id, role, channel, status, content)
			 VALUES ($1, 'user', 'telegram', 'complete', 'hello') RETURNING id`,
			[convoId],
		);
		messageId = msg.rows[0].id;
		await h.db.query(
			`INSERT INTO chat_channel_configs (channel, enabled, bot_token_secret, webhook_secret, metadata)
			 VALUES ('telegram', true, 'TELEGRAM_BOT_TOKEN', 'whsec', '{"group_id":"-100"}'::jsonb)`,
		);

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it("adds 'slack' and 'discord' to the chat_channel enum, usable post-migration", async () => {
		const e = await h.db.query<{ enumlabel: string }>(
			`SELECT enumlabel FROM pg_enum
			 JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
			 WHERE pg_type.typname = 'chat_channel' ORDER BY enumlabel`,
		);
		const labels = e.rows.map((r) => r.enumlabel);
		expect(labels).toContain('slack');
		expect(labels).toContain('discord');
		const inserted = await h.db.query<{ channel: string }>(
			`INSERT INTO chat_channel_configs (channel, enabled) VALUES ('slack', false)
			 RETURNING channel::text AS channel`,
		);
		expect(inserted.rows[0].channel).toBe('slack');
	});

	it("adds chat_conversations.kind defaulting pre-existing rows to 'assistant'", async () => {
		const row = await h.db.query<{ kind: string }>(
			`SELECT kind::text AS kind FROM chat_conversations WHERE id = $1`,
			[convoId],
		);
		expect(row.rows[0].kind).toBe('assistant');
		const coworker = await h.db.query<{ kind: string }>(
			`INSERT INTO chat_conversations (member_id, team_id, project_id, channel, external_thread_id, kind)
			 SELECT member_id, team_id, project_id, 'telegram', '-200:1', 'coworker' FROM chat_conversations WHERE id = $1
			 RETURNING kind::text AS kind`,
			[convoId],
		);
		expect(coworker.rows[0].kind).toBe('coworker');
	});

	it('drops the mirror-era bindings table; the conversation row keeps the routing key', async () => {
		const t = await h.db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM information_schema.tables
			 WHERE table_name = 'chat_conversation_bindings'`,
		);
		expect(t.rows[0].c).toBe(0);
		// Inbound routing resolves off the conversation row itself.
		const byKey = await h.db.query<{ id: string }>(
			`SELECT id FROM chat_conversations
			 WHERE channel = 'telegram' AND external_thread_id = '-100:7' AND closed_at IS NULL`,
		);
		expect(byKey.rows[0]?.id).toBe(convoId);
	});

	it('creates the observed-message buffer table', async () => {
		await h.db.query(
			`INSERT INTO chat_observed_messages (channel, external_chat_id, thread_scope, sender_label, content, message_ts)
			 VALUES ('telegram', '-300', NULL, 'Alice', 'we ship friday', '42')`,
		);
		const r = await h.db.query<{ sender_label: string }>(
			`SELECT sender_label FROM chat_observed_messages WHERE external_chat_id = '-300'`,
		);
		expect(r.rows[0].sender_label).toBe('Alice');
	});

	it('adds chat_messages.author_label (NULL on pre-existing rows) and preserves data', async () => {
		const row = await h.db.query<{ author_label: string | null; content: string }>(
			`SELECT author_label, content FROM chat_messages WHERE id = $1`,
			[messageId],
		);
		expect(row.rows[0].author_label).toBeNull();
		expect(row.rows[0].content).toBe('hello');
		const config = await h.db.query<{ metadata: { group_id?: string } }>(
			`SELECT metadata FROM chat_channel_configs WHERE channel = 'telegram'`,
		);
		expect(config.rows[0].metadata.group_id).toBe('-100');
	});
});
