import { ChatChannel } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PgliteDb } from '../src/db/drivers/pglite';
import {
	OBSERVED_BUFFER_LIMIT,
	readObservedContext,
	recordObservedMessage,
} from '../src/services/chat-channels/observed-messages';
import { createTestDbWithMigrations } from './helpers/db';

// The bounded witnessed-message buffer that stands in for channel history on
// platforms without a history API (Telegram).
describe('chat observed-message buffer', () => {
	let db: PgliteDb;

	beforeAll(async () => {
		db = await createTestDbWithMigrations();
	});
	afterAll(() => db.close());

	const record = (chat: string, n: number, text: string, scope: string | null = null) =>
		recordObservedMessage(db, {
			channel: ChatChannel.Telegram,
			externalChatId: chat,
			threadScope: scope,
			senderLabel: `Sender${n}`,
			content: text,
			messageTs: String(n),
		});

	it('replays a chat’s buffer oldest-first as prompt context', async () => {
		await record('-1', 1, 'first');
		await record('-1', 2, 'second');
		const ctx = await readObservedContext(db, {
			channel: ChatChannel.Telegram,
			externalChatId: '-1',
		});
		expect(ctx.map((m) => m.text)).toEqual(['first', 'second']);
		expect(ctx[0].sender).toBe('Sender1');
		expect(ctx[0].timestamp).toBeTruthy();
	});

	it('dedupes webhook redeliveries by platform message id', async () => {
		await record('-2', 1, 'once');
		await record('-2', 1, 'once');
		const ctx = await readObservedContext(db, {
			channel: ChatChannel.Telegram,
			externalChatId: '-2',
		});
		expect(ctx).toHaveLength(1);
	});

	it('scopes forum-topic reads to their topic', async () => {
		await record('-3', 1, 'in topic 7', '7');
		await record('-3', 2, 'in topic 9', '9');
		await record('-3', 3, 'plain group floor');
		const topic7 = await readObservedContext(db, {
			channel: ChatChannel.Telegram,
			externalChatId: '-3',
			threadScope: '7',
		});
		expect(topic7.map((m) => m.text)).toEqual(['in topic 7']);
		const whole = await readObservedContext(db, {
			channel: ChatChannel.Telegram,
			externalChatId: '-3',
		});
		expect(whole).toHaveLength(3);
	});

	it('prunes each chat to the buffer cap, keeping the newest rows', async () => {
		for (let i = 0; i < OBSERVED_BUFFER_LIMIT + 25; i++) {
			await record('-4', i, `msg ${i}`);
		}
		const count = await db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM chat_observed_messages WHERE external_chat_id = '-4'`,
		);
		expect(count.rows[0].c).toBe(OBSERVED_BUFFER_LIMIT);
		const ctx = await readObservedContext(db, {
			channel: ChatChannel.Telegram,
			externalChatId: '-4',
			limit: OBSERVED_BUFFER_LIMIT,
		});
		expect(ctx.at(-1)?.text).toBe(`msg ${OBSERVED_BUFFER_LIMIT + 24}`);
		// Other chats' buffers are untouched by the prune.
		const other = await readObservedContext(db, {
			channel: ChatChannel.Telegram,
			externalChatId: '-1',
		});
		expect(other.length).toBeGreaterThan(0);
	});
});
