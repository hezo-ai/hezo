import { describe, expect, it } from 'vitest';
import {
	decodeSlackThreadId,
	encodeSlackThreadId,
	SlackAdapter,
	splitForSlack,
	stripBotMention,
	toSlackMrkdwn,
} from '../src/services/chat-channels/slack';
import type { ChatChannelAdapterDeps } from '../src/services/chat-channels/types';

// parseInbound / parseGroupMention are pure and touch no DB, so a bare deps stub
// suffices (same pattern as chat-telegram-adapter.test.ts).
const adapter = () => new SlackAdapter({} as ChatChannelAdapterDeps);

describe('slack thread id encoding', () => {
	it('round-trips a DM (bare channel) and a group thread', () => {
		expect(encodeSlackThreadId('D123')).toBe('D123');
		expect(encodeSlackThreadId('C42', '1721.0001')).toBe('C42:1721.0001');
		expect(decodeSlackThreadId('D123')).toEqual({ channelId: 'D123' });
		expect(decodeSlackThreadId('C42:1721.0001')).toEqual({
			channelId: 'C42',
			threadTs: '1721.0001',
		});
	});
});

describe('parseInbound (DM/assistant mode)', () => {
	it('maps a DM to a bare-channel-keyed event', () => {
		const event = adapter().parseInbound({
			type: 'message',
			channel_type: 'im',
			user: 'U1',
			text: 'hello ceo',
			channel: 'D123',
			ts: '1.0',
		});
		expect(event).toEqual({ externalUserId: 'U1', externalThreadId: 'D123', text: 'hello ceo' });
	});

	it('ignores non-DM messages, subtypes, bot posts, and malformed events', () => {
		const a = adapter();
		expect(
			a.parseInbound({
				type: 'message',
				channel_type: 'channel',
				user: 'U1',
				text: 'x',
				channel: 'C1',
			}),
		).toBeNull();
		expect(
			a.parseInbound({
				type: 'message',
				channel_type: 'im',
				subtype: 'message_changed',
				user: 'U1',
				text: 'x',
				channel: 'D1',
			}),
		).toBeNull();
		expect(
			a.parseInbound({
				type: 'message',
				channel_type: 'im',
				bot_id: 'B1',
				text: 'x',
				channel: 'D1',
			}),
		).toBeNull();
		expect(
			a.parseInbound({ type: 'app_mention', user: 'U1', text: 'x', channel: 'C1' }),
		).toBeNull();
		expect(a.parseInbound(null)).toBeNull();
		expect(a.parseInbound('nope')).toBeNull();
	});
});

describe('parseGroupMention (group/coworker mode)', () => {
	it('keys a top-level mention by its own ts (the reply roots a thread)', () => {
		const event = adapter().parseGroupMention({
			type: 'app_mention',
			user: 'U1',
			text: '<@UBOT> make a plan from our chat',
			channel: 'C42',
			ts: '1721.0001',
		});
		expect(event).toEqual({
			externalUserId: 'U1',
			externalThreadId: 'C42:1721.0001',
			text: 'make a plan from our chat',
			isThreadReply: false,
			messageTs: '1721.0001',
		});
	});

	it('keys an in-thread mention by the thread root ts', () => {
		const event = adapter().parseGroupMention({
			type: 'app_mention',
			user: 'U1',
			text: '<@UBOT> and document it',
			channel: 'C42',
			ts: '1721.0009',
			thread_ts: '1721.0001',
		});
		expect(event?.externalThreadId).toBe('C42:1721.0001');
		expect(event?.isThreadReply).toBe(true);
		expect(event?.messageTs).toBe('1721.0009');
	});

	it('ignores bot posts, empty-after-strip mentions, and malformed events', () => {
		const a = adapter();
		expect(
			a.parseGroupMention({ type: 'app_mention', bot_id: 'B1', text: 'x', channel: 'C1', ts: '1' }),
		).toBeNull();
		expect(
			a.parseGroupMention({
				type: 'app_mention',
				user: 'U1',
				text: '<@UBOT>',
				channel: 'C1',
				ts: '1',
			}),
		).toBeNull();
		expect(
			a.parseGroupMention({ type: 'message', user: 'U1', text: 'x', channel: 'C1', ts: '1' }),
		).toBeNull();
		expect(a.parseGroupMention(undefined)).toBeNull();
	});
});

describe('stripBotMention', () => {
	it('strips only the bot when its id is known', () => {
		expect(stripBotMention('<@UBOT> loop in <@UALICE> please', 'UBOT')).toBe(
			'loop in <@UALICE> please',
		);
		expect(stripBotMention('hey <@UBOT|hezo> — plan?', 'UBOT')).toBe('hey — plan?');
	});

	it('strips any mention token when the bot id is unknown', () => {
		expect(stripBotMention('<@UBOT> hello', null)).toBe('hello');
	});
});

describe('toSlackMrkdwn', () => {
	it('maps bold, links, and headings; escapes entities', () => {
		expect(toSlackMrkdwn('**bold** and [docs](https://hezo.ai/docs)')).toBe(
			'*bold* and <https://hezo.ai/docs|docs>',
		);
		expect(toSlackMrkdwn('# Plan\nuse a < b & c > d')).toBe('*Plan*\nuse a &lt; b &amp; c &gt; d');
	});

	it('leaves code fences and inline code untouched', () => {
		const fenced = '```\nconst a = 1 < 2 && 3;\n```';
		expect(toSlackMrkdwn(fenced)).toBe(fenced);
		expect(toSlackMrkdwn('run `a && b` now')).toBe('run `a && b` now');
	});
});

describe('splitForSlack', () => {
	it('returns short messages whole', () => {
		expect(splitForSlack('hello')).toEqual(['hello']);
	});

	it('splits on paragraph boundaries under the cap', () => {
		const chunks = splitForSlack(`${'a'.repeat(30)}\n\n${'b'.repeat(30)}`, 40);
		expect(chunks).toEqual(['a'.repeat(30), 'b'.repeat(30)]);
	});

	it('hard-splits a single oversized paragraph', () => {
		const chunks = splitForSlack('x'.repeat(95), 40);
		expect(chunks.map((c) => c.length)).toEqual([40, 40, 15]);
		expect(chunks.join('')).toBe('x'.repeat(95));
	});
});
