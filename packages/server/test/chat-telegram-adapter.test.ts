import { ChatChannel } from '@hezo/shared';
import { describe, expect, it } from 'vitest';
import { escapeMarkdownV2, TelegramAdapter } from '../src/services/chat-channels/telegram';
import type { ChatChannelAdapterDeps } from '../src/services/chat-channels/types';

// parseInbound + escaping are pure — no DB/master key touched, so a bare deps stub
// is fine.
const deps = {} as ChatChannelAdapterDeps;
const adapter = new TelegramAdapter(deps);

describe('escapeMarkdownV2', () => {
	it('escapes every MarkdownV2 reserved character', () => {
		expect(escapeMarkdownV2('a_b*c[d]e(f)')).toBe('a\\_b\\*c\\[d\\]e\\(f\\)');
		expect(escapeMarkdownV2('1. item! > note')).toBe('1\\. item\\! \\> note');
		expect(escapeMarkdownV2('a-b=c|d{e}f.g')).toBe('a\\-b\\=c\\|d\\{e\\}f\\.g');
	});

	it('escapes backslashes and backticks', () => {
		expect(escapeMarkdownV2('a\\b`c`')).toBe('a\\\\b\\`c\\`');
	});

	it('leaves ordinary text untouched', () => {
		expect(escapeMarkdownV2('hello world 42')).toBe('hello world 42');
	});
});

describe('TelegramAdapter.parseInbound', () => {
	it('keys a private DM by the bare chat id', () => {
		const event = adapter.parseInbound({
			message: {
				text: 'hi',
				from: { id: 42, username: 'op' },
				chat: { id: 999, type: 'private' },
			},
		});
		expect(event).toEqual({
			externalUserId: '42',
			externalThreadId: '999',
			externalHandle: '@op',
			text: 'hi',
		});
	});

	it('keys a forum-topic message by chat id + message_thread_id', () => {
		const event = adapter.parseInbound({
			message: {
				text: 'in topic',
				message_thread_id: 7,
				is_topic_message: true,
				from: { id: 42 },
				chat: { id: -100123, type: 'supergroup' },
			},
		});
		expect(event?.externalThreadId).toBe('-100123:7');
		expect(event?.text).toBe('in topic');
		expect(event?.externalHandle).toBeUndefined();
	});

	it('ignores the bot’s own messages, non-text updates, and malformed payloads', () => {
		expect(
			adapter.parseInbound({
				message: { text: 'x', from: { id: 1, is_bot: true }, chat: { id: 2 } },
			}),
		).toBeNull();
		expect(adapter.parseInbound({ message: { from: { id: 1 }, chat: { id: 2 } } })).toBeNull();
		expect(adapter.parseInbound({ edited_message: { text: 'x' } })).toBeNull();
		expect(adapter.parseInbound(null)).toBeNull();
	});

	it('is the telegram channel', () => {
		expect(adapter.channel).toBe(ChatChannel.Telegram);
	});
});
