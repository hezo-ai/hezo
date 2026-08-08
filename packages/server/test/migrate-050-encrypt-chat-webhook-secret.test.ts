import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decrypt } from '../src/crypto/encryption';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '050_encrypt_chat_webhook_secret.sql';

/**
 * `chat_channel_configs.webhook_secret` was the one bearer credential in the
 * schema kept in plaintext: anyone who could read the database (or a logical
 * backup, which exports raw column values) could POST to
 * `/api/webhooks/chat/:channel/:secret` and inject inbound messages as the
 * platform.
 *
 * The migration cannot re-encode it — encryption needs the master key, and
 * migrations run at boot while the instance is still locked. So it only adds the
 * ciphertext column, and the plaintext must survive untouched: the platform
 * already holds a webhook URL containing that value, so destroying it here would
 * silently break inbound delivery until an operator re-registered by hand.
 * `backfillChatWebhookSecrets()` converts it on the next unlock.
 */
describe('050_encrypt_chat_webhook_secret migration', () => {
	let h: DataPreservationHarness;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);
		await h.db.query(
			`INSERT INTO chat_channel_configs (channel, enabled, bot_token_secret, webhook_secret, metadata)
			 VALUES ('telegram', true, 'TELEGRAM_BOT_TOKEN', 'legacy-plaintext-webhook-secret', '{"group_id":"-100"}'::jsonb)`,
		);
		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('adds the ciphertext column', async () => {
		const c = await h.db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM information_schema.columns
			 WHERE table_name = 'chat_channel_configs' AND column_name = 'webhook_secret_encrypted'`,
		);
		expect(c.rows[0].c).toBe(1);
	});

	it('leaves the new column null so the backfill can tell converted rows apart', async () => {
		const r = await h.db.query<{ webhook_secret_encrypted: string | null }>(
			`SELECT webhook_secret_encrypted FROM chat_channel_configs WHERE channel = 'telegram'`,
		);
		expect(r.rows[0].webhook_secret_encrypted).toBeNull();
	});

	it('preserves the pre-existing row, including the legacy secret and its siblings', async () => {
		const r = await h.db.query<{
			enabled: boolean;
			bot_token_secret: string | null;
			webhook_secret: string | null;
			metadata: Record<string, unknown>;
		}>(
			`SELECT enabled, bot_token_secret, webhook_secret, metadata
			 FROM chat_channel_configs WHERE channel = 'telegram'`,
		);
		expect(r.rows.length).toBe(1);
		// The live webhook keeps authenticating across the whole upgrade window.
		expect(r.rows[0].webhook_secret).toBe('legacy-plaintext-webhook-secret');
		expect(r.rows[0].enabled).toBe(true);
		expect(r.rows[0].bot_token_secret).toBe('TELEGRAM_BOT_TOKEN');
		expect(r.rows[0].metadata).toEqual({ group_id: '-100' });
	});

	it('the backfill then re-encodes the legacy value and clears the plaintext', async () => {
		const key = Buffer.alloc(32, 7);
		const { backfillChatWebhookSecrets } = await import('../src/services/chat-channels');
		const converted = await backfillChatWebhookSecrets({
			db: h.db,
			masterKeyManager: { getKey: () => key } as never,
		});
		expect(converted).toBe(1);

		const r = await h.db.query<{
			webhook_secret: string | null;
			webhook_secret_encrypted: string | null;
		}>(
			`SELECT webhook_secret, webhook_secret_encrypted
			 FROM chat_channel_configs WHERE channel = 'telegram'`,
		);
		expect(r.rows[0].webhook_secret).toBeNull();
		expect(r.rows[0].webhook_secret_encrypted).not.toBeNull();
		// Round-trips to the original: converted at rest, unchanged in meaning, so
		// the webhook URL the platform holds still authenticates.
		expect(decrypt(r.rows[0].webhook_secret_encrypted as string, key)).toBe(
			'legacy-plaintext-webhook-secret',
		);

		// Idempotent: a second unlock converts nothing.
		expect(
			await backfillChatWebhookSecrets({
				db: h.db,
				masterKeyManager: { getKey: () => key } as never,
			}),
		).toBe(0);
	});
});
