import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '030_chat_channels_and_identities.sql';

// Seeds a user at schema 029, applies the channel-config + identity-link migration,
// and asserts both new tables exist, a pre-existing user survives, and a config +
// identity link round-trip (including the (channel, external_user_id) uniqueness).
describe('030_chat_channels_and_identities migration', () => {
	let h: DataPreservationHarness;
	let userId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		const user = await h.db.query<{ id: string }>(
			`INSERT INTO users (display_name) VALUES ('Operator') RETURNING id`,
		);
		userId = user.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('creates both new tables', async () => {
		const t = await h.db.query<{ table_name: string }>(
			`SELECT table_name FROM information_schema.tables
			 WHERE table_name IN ('chat_channel_configs', 'chat_identity_links')`,
		);
		const names = t.rows.map((r) => r.table_name);
		expect(names).toContain('chat_channel_configs');
		expect(names).toContain('chat_identity_links');
	});

	it('preserves the pre-existing user', async () => {
		const u = await h.db.query(`SELECT 1 FROM users WHERE id = $1`, [userId]);
		expect(u.rows.length).toBe(1);
	});

	it('round-trips a channel config keyed by channel', async () => {
		await h.db.query(
			`INSERT INTO chat_channel_configs (channel, enabled, bot_token_secret, webhook_secret, metadata)
			 VALUES ('telegram', true, 'telegram_bot_token', 'sekret', '{"group_id":"-100123"}'::jsonb)`,
		);
		const cfg = await h.db.query<{ enabled: boolean; group_id: string }>(
			`SELECT enabled, metadata->>'group_id' AS group_id
			 FROM chat_channel_configs WHERE channel = 'telegram'`,
		);
		expect(cfg.rows[0].enabled).toBe(true);
		expect(cfg.rows[0].group_id).toBe('-100123');
	});

	it('links an external identity to a user and enforces per-channel uniqueness', async () => {
		await h.db.query(
			`INSERT INTO chat_identity_links (channel, external_user_id, user_id, external_handle)
			 VALUES ('telegram', '42', $1, '@op')`,
			[userId],
		);
		const link = await h.db.query<{ user_id: string }>(
			`SELECT user_id FROM chat_identity_links WHERE channel = 'telegram' AND external_user_id = '42'`,
		);
		expect(link.rows[0].user_id).toBe(userId);

		// A second link for the same (channel, external_user_id) is rejected.
		await expect(
			h.db.query(
				`INSERT INTO chat_identity_links (channel, external_user_id, user_id)
				 VALUES ('telegram', '42', $1)`,
				[userId],
			),
		).rejects.toThrow();
	});

	it('cascades identity-link deletion when the user is removed', async () => {
		const user = await h.db.query<{ id: string }>(
			`INSERT INTO users (display_name) VALUES ('Temp') RETURNING id`,
		);
		await h.db.query(
			`INSERT INTO chat_identity_links (channel, external_user_id, user_id)
			 VALUES ('telegram', '99', $1)`,
			[user.rows[0].id],
		);
		await h.db.query(`DELETE FROM users WHERE id = $1`, [user.rows[0].id]);
		const gone = await h.db.query(
			`SELECT 1 FROM chat_identity_links WHERE external_user_id = '99'`,
		);
		expect(gone.rows.length).toBe(0);
	});
});
