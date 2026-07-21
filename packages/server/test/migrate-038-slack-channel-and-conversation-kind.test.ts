import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '038_slack_channel_and_conversation_kind.sql';

// Seeds a mirror-era conversation + message + telegram channel config + binding at
// schema 037, applies the migration, and asserts: 'slack' joined the chat_channel
// enum (and is usable), chat_conversations.kind exists and defaults pre-existing
// rows to 'mirror', chat_messages.author_label exists and is NULL on old rows, and
// every seeded row survived.
describe('038_slack_channel_and_conversation_kind migration', () => {
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

	it("adds 'slack' to the chat_channel enum and makes it usable", async () => {
		const e = await h.db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM pg_enum
			 JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
			 WHERE pg_type.typname = 'chat_channel' AND pg_enum.enumlabel = 'slack'`,
		);
		expect(e.rows[0].c).toBe(1);
		// The new value is actually usable post-migration (it must not be used
		// *inside* 038's own transaction, but is fine afterwards).
		const inserted = await h.db.query<{ channel: string }>(
			`INSERT INTO chat_channel_configs (channel, enabled) VALUES ('slack', false)
			 RETURNING channel::text AS channel`,
		);
		expect(inserted.rows[0].channel).toBe('slack');
	});

	it("adds chat_conversations.kind defaulting pre-existing rows to 'mirror'", async () => {
		const col = await h.db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM information_schema.columns
			 WHERE table_name = 'chat_conversations' AND column_name = 'kind'`,
		);
		expect(col.rows[0].c).toBe(1);
		const row = await h.db.query<{ kind: string }>(
			`SELECT kind::text AS kind FROM chat_conversations WHERE id = $1`,
			[convoId],
		);
		expect(row.rows[0].kind).toBe('mirror');
		// The coworker kind is insertable.
		const coworker = await h.db.query<{ kind: string }>(
			`INSERT INTO chat_conversations (member_id, team_id, project_id, channel, external_thread_id, kind)
			 SELECT member_id, team_id, project_id, 'telegram', 'C42:1.2', 'coworker' FROM chat_conversations WHERE id = $1
			 RETURNING kind::text AS kind`,
			[convoId],
		);
		expect(coworker.rows[0].kind).toBe('coworker');
	});

	it('adds chat_messages.author_label, NULL on pre-existing rows', async () => {
		const row = await h.db.query<{ author_label: string | null; content: string }>(
			`SELECT author_label, content FROM chat_messages WHERE id = $1`,
			[messageId],
		);
		expect(row.rows[0].author_label).toBeNull();
		expect(row.rows[0].content).toBe('hello');
	});

	it('preserves pre-existing rows', async () => {
		const convo = await h.db.query<{ external_thread_id: string }>(
			`SELECT external_thread_id FROM chat_conversations WHERE id = $1`,
			[convoId],
		);
		expect(convo.rows[0].external_thread_id).toBe('-100:7');
		const binding = await h.db.query(
			`SELECT 1 FROM chat_conversation_bindings WHERE conversation_id = $1 AND channel = 'telegram'`,
			[convoId],
		);
		expect(binding.rows.length).toBe(1);
		const config = await h.db.query<{ metadata: { group_id?: string } }>(
			`SELECT metadata FROM chat_channel_configs WHERE channel = 'telegram'`,
		);
		expect(config.rows[0].metadata.group_id).toBe('-100');
	});
});
