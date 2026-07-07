import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '022_chat_message_attachments.sql';

// Seeds a chat message + asset at schema 021, applies the attachments migration,
// and asserts the join table exists, the pre-existing rows survived, and a
// (message, asset) link can be created and read back.
describe('022_chat_message_attachments migration', () => {
	let h: DataPreservationHarness;
	let messageId: string;
	let assetId: string;

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
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, 'agent', 'CEO') RETURNING id`,
			[teamId],
		);
		const ceoMemberId = member.rows[0].id;

		const convo = await h.db.query<{ id: string }>(
			`INSERT INTO chat_conversations (member_id, team_id, project_id) VALUES ($1, $2, $3) RETURNING id`,
			[ceoMemberId, teamId, projectId],
		);
		const msg = await h.db.query<{ id: string }>(
			`INSERT INTO chat_messages (conversation_id, role, channel, status, content)
			 VALUES ($1, 'user', 'web', 'complete', 'here is a file') RETURNING id`,
			[convo.rows[0].id],
		);
		messageId = msg.rows[0].id;

		const asset = await h.db.query<{ id: string }>(
			`INSERT INTO assets (team_id, project_id, content_type, byte_size, sha256, original_filename)
			 VALUES ($1, $2, 'image/png', 123, 'abc', 'uploads/chat/diagram.png') RETURNING id`,
			[teamId, projectId],
		);
		assetId = asset.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('creates the chat_message_attachments table', async () => {
		const t = await h.db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM information_schema.tables
			 WHERE table_name = 'chat_message_attachments'`,
		);
		expect(t.rows[0].c).toBe(1);
	});

	it('preserves the pre-existing message and asset', async () => {
		const m = await h.db.query(`SELECT 1 FROM chat_messages WHERE id = $1`, [messageId]);
		expect(m.rows.length).toBe(1);
		const a = await h.db.query(`SELECT 1 FROM assets WHERE id = $1`, [assetId]);
		expect(a.rows.length).toBe(1);
	});

	it('links an asset to a message and reads it back', async () => {
		await h.db.query(
			`INSERT INTO chat_message_attachments (chat_message_id, asset_id) VALUES ($1, $2)`,
			[messageId, assetId],
		);
		const link = await h.db.query<{ asset_id: string }>(
			`SELECT asset_id FROM chat_message_attachments WHERE chat_message_id = $1`,
			[messageId],
		);
		expect(link.rows.length).toBe(1);
		expect(link.rows[0].asset_id).toBe(assetId);
	});
});
