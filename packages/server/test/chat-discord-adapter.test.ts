import { describe, expect, it } from 'vitest';
import { DiscordAdapter, stripDiscordMention } from '../src/services/chat-channels/discord';
import type { ChatChannelAdapterDeps } from '../src/services/chat-channels/types';

// parse methods are pure — no DB/master key touched, so a bare deps stub is
// fine; the bot identity start() normally caches is primed directly.
const deps = {} as ChatChannelAdapterDeps;

function adapter() {
	const a = new DiscordAdapter(deps);
	a.primeRuntimeCache('BOT1');
	return a;
}

describe('DiscordAdapter.parseInbound (DM/assistant mode)', () => {
	it('maps a DM (no guild_id) to a channel-keyed event', () => {
		const event = adapter().parseInbound({
			id: 'm1',
			content: 'hello ceo',
			channel_id: 'D9',
			author: { id: 'U1', username: 'farez' },
		});
		expect(event).toEqual({
			externalUserId: 'U1',
			externalThreadId: 'D9',
			externalHandle: 'farez',
			text: 'hello ceo',
		});
	});

	it('ignores guild messages, bot posts, and malformed payloads', () => {
		const a = adapter();
		expect(
			a.parseInbound({
				content: 'x',
				channel_id: 'C1',
				guild_id: 'G1',
				author: { id: 'U1' },
			}),
		).toBeNull();
		expect(
			a.parseInbound({ content: 'x', channel_id: 'D1', author: { id: 'B9', bot: true } }),
		).toBeNull();
		expect(a.parseInbound(null)).toBeNull();
	});
});

describe('DiscordAdapter.parseGroupMention (coworker mode)', () => {
	const base = {
		id: 'm41',
		channel_id: 'C42',
		guild_id: 'G1',
		author: { id: 'U1', username: 'farez', global_name: 'Farez' },
	};

	it('fires on a bot mention, stripping the token; keys by channel id', () => {
		const event = adapter().parseGroupMention({
			...base,
			content: '<@BOT1> make a plan from our chat',
			mentions: [{ id: 'BOT1' }],
		});
		expect(event).toMatchObject({
			externalUserId: 'U1',
			externalThreadId: 'C42',
			text: 'make a plan from our chat',
			senderDisplayName: 'Farez',
			isThreadReply: false,
			messageTs: 'm41',
		});
	});

	it('fires on a reply to the bot and quotes a replied-to human', () => {
		const continuation = adapter().parseGroupMention({
			...base,
			content: 'also loop in QA',
			referenced_message: { author: { id: 'BOT1', bot: true }, content: 'Plan posted.' },
		});
		expect(continuation?.text).toBe('also loop in QA');
		expect(continuation?.inlineContext).toBeUndefined();

		const quoted = adapter().parseGroupMention({
			...base,
			content: '<@!BOT1> thoughts?',
			mentions: [{ id: 'BOT1' }],
			referenced_message: {
				author: { id: 'U2', username: 'alice', global_name: 'Alice' },
				content: 'we ship friday',
			},
		});
		expect(quoted?.inlineContext).toEqual([{ sender: 'Alice', text: 'we ship friday' }]);
		expect(quoted?.isThreadReply).toBe(true);
	});

	it('never fires without a mention/reply, on bots, in DMs, or before start()', () => {
		const a = adapter();
		expect(a.parseGroupMention({ ...base, content: 'no mention' })).toBeNull();
		expect(
			a.parseGroupMention({
				...base,
				content: '<@BOT1> hi',
				author: { id: 'B2', bot: true },
			}),
		).toBeNull();
		expect(
			a.parseGroupMention({
				id: 'm1',
				content: '<@BOT1> hi',
				channel_id: 'D1',
				author: { id: 'U1' },
			}),
		).toBeNull();
		expect(a.parseGroupMention({ ...base, content: '<@BOT1>' })).toBeNull();
		const cold = new DiscordAdapter(deps);
		expect(cold.parseGroupMention({ ...base, content: '<@BOT1> hi' })).toBeNull();
	});
});

describe('stripDiscordMention', () => {
	it('strips only the bot when its id is known (both mention forms)', () => {
		expect(stripDiscordMention('<@BOT1> loop in <@U2> please', 'BOT1')).toBe(
			'loop in <@U2> please',
		);
		expect(stripDiscordMention('hey <@!BOT1> — plan?', 'BOT1')).toBe('hey — plan?');
	});

	it('strips any mention token when the bot id is unknown', () => {
		expect(stripDiscordMention('<@123> hello', null)).toBe('hello');
	});
});
