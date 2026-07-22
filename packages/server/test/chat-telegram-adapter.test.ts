import { ChatChannel } from '@hezo/shared';
import { describe, expect, it } from 'vitest';
import { escapeMarkdownV2, TelegramAdapter } from '../src/services/chat-channels/telegram';
import type { ChatChannelAdapterDeps } from '../src/services/chat-channels/types';

// parseInbound / parseGroupMention / escaping are pure — no DB/master key
// touched, so a bare deps stub is fine. The runtime cache start() normally
// fills (bot identity + designated supergroup) is primed directly.
const deps = {} as ChatChannelAdapterDeps;

function adapter(mirrorGroupId: string | null = '-100123') {
	const a = new TelegramAdapter(deps);
	a.primeRuntimeCache({ id: 777, username: 'hezo_bot' }, mirrorGroupId);
	return a;
}

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

describe('TelegramAdapter.parseInbound (assistant surfaces only)', () => {
	it('keys a private DM by the bare chat id', () => {
		const event = adapter().parseInbound({
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

	it('keys a designated-supergroup topic by chat id + message_thread_id', () => {
		const event = adapter('-100123').parseInbound({
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

	it('ignores messages in any other group — those belong to coworker mode', () => {
		expect(
			adapter('-100123').parseInbound({
				message: { text: 'chatter', from: { id: 42 }, chat: { id: -555, type: 'group' } },
			}),
		).toBeNull();
		// No designated supergroup configured → no group is an assistant surface.
		expect(
			adapter(null).parseInbound({
				message: { text: 'x', from: { id: 42 }, chat: { id: -100123, type: 'supergroup' } },
			}),
		).toBeNull();
	});

	it('ignores the bot’s own messages, non-text updates, and malformed payloads', () => {
		expect(
			adapter().parseInbound({
				message: { text: 'x', from: { id: 1, is_bot: true }, chat: { id: 2, type: 'private' } },
			}),
		).toBeNull();
		expect(
			adapter().parseInbound({ message: { from: { id: 1 }, chat: { id: 2, type: 'private' } } }),
		).toBeNull();
		expect(adapter().parseInbound({ edited_message: { text: 'x' } })).toBeNull();
		expect(adapter().parseInbound(null)).toBeNull();
	});

	it('is the telegram channel', () => {
		expect(adapter().channel).toBe(ChatChannel.Telegram);
	});
});

describe('TelegramAdapter.parseGroupMention (coworker mode)', () => {
	const group = { id: -555, type: 'supergroup', title: 'Growth group' };

	it('fires on @botusername in a non-designated group, stripping the mention', () => {
		const event = adapter().parseGroupMention({
			message: {
				message_id: 41,
				text: '@hezo_bot make a plan from our chat',
				from: { id: 42, first_name: 'Farez', last_name: 'Rahman' },
				chat: group,
			},
		});
		expect(event).toMatchObject({
			externalUserId: '42',
			externalThreadId: '-555',
			text: 'make a plan from our chat',
			senderDisplayName: 'Farez Rahman',
			channelName: 'Growth group',
			isThreadReply: false,
			messageTs: '41',
		});
	});

	it('keys a forum-topic mention per topic — parallel threads', () => {
		const event = adapter().parseGroupMention({
			message: {
				message_id: 9,
				message_thread_id: 3,
				text: '@hezo_bot summarize this topic',
				from: { id: 42, first_name: 'Ada' },
				chat: { id: -777, type: 'supergroup', title: 'Eng' },
			},
		});
		expect(event?.externalThreadId).toBe('-777:3');
		expect(event?.isThreadReply).toBe(true);
	});

	it('fires on a reply to the bot (continuation) and quotes a replied-to human', () => {
		// Reply to the bot: continuation, no inline quote (bot text is in the window).
		const continuation = adapter().parseGroupMention({
			message: {
				message_id: 50,
				text: 'also loop in QA',
				from: { id: 42, first_name: 'Farez' },
				chat: group,
				reply_to_message: { message_id: 49, text: 'Plan posted.', from: { id: 777, is_bot: true } },
			},
		});
		expect(continuation?.text).toBe('also loop in QA');
		expect(continuation?.inlineContext).toBeUndefined();

		// Mention that replies to a human: the quoted hop rides as inline context.
		const quoted = adapter().parseGroupMention({
			message: {
				message_id: 51,
				text: '@hezo_bot what do you think about this?',
				from: { id: 42, first_name: 'Farez' },
				chat: group,
				reply_to_message: {
					message_id: 48,
					text: 'we should ship friday',
					from: { id: 43, first_name: 'Alice' },
				},
			},
		});
		expect(quoted?.inlineContext).toEqual([{ sender: 'Alice', text: 'we should ship friday' }]);
		expect(quoted?.isThreadReply).toBe(true);
	});

	it('never fires in DMs, the designated supergroup, without a mention, or before start()', () => {
		const a = adapter('-100123');
		expect(
			a.parseGroupMention({
				message: {
					text: '@hezo_bot hi',
					from: { id: 42 },
					chat: { id: 999, type: 'private' },
				},
			}),
		).toBeNull();
		expect(
			a.parseGroupMention({
				message: {
					text: '@hezo_bot hi',
					from: { id: 42 },
					chat: { id: -100123, type: 'supergroup' },
				},
			}),
		).toBeNull();
		expect(
			a.parseGroupMention({
				message: { text: 'no mention here', from: { id: 42 }, chat: group },
			}),
		).toBeNull();
		expect(
			a.parseGroupMention({
				message: { text: '@hezo_bot', from: { id: 42 }, chat: group },
			}),
		).toBeNull();
		// Unprimed identity (start() hasn't run) → mentions are undetectable.
		const cold = new TelegramAdapter(deps);
		expect(
			cold.parseGroupMention({
				message: { text: '@hezo_bot hi', from: { id: 42 }, chat: group },
			}),
		).toBeNull();
	});
});
