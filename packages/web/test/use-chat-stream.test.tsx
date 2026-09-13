// Coverage for the WS-streamed side of use-chat.ts. The component harness
// stubs WebSocket to a no-op, so the subscribe handlers (message start / delta /
// complete / compacted) never fire in the widget specs. Here the socket context
// itself is mocked with a controllable emitter and the hooks are driven
// directly: events are emitted and the derived state (messages, streaming,
// suggested replies) is asserted — plus the header monogram's unread tally
// (`useCeoUnread`), its localStorage persistence, and the private-mode
// (throwing storage) fallbacks.

import { ChatMessageStatus, WsMessageType } from '@hezo/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useCeoUnread, useChat } from '../src/hooks/use-chat';
import { api } from '../src/lib/api';
import { queryKeys } from '../src/lib/query-keys';

const socket = vi.hoisted(() => {
	const handlers = new Map<string, Set<(msg: unknown) => void>>();
	return {
		handlers,
		emit(type: string, msg: unknown) {
			for (const h of handlers.get(type) ?? []) h(msg);
		},
	};
});

// use-chat resolves useSocket from this module; swap it for the emitter.
vi.mock('../src/contexts/socket-context', () => ({
	useSocket: () => ({
		connected: true,
		subscribe: (type: string, handler: (msg: unknown) => void) => {
			let set = socket.handlers.get(type);
			if (!set) {
				set = new Set();
				socket.handlers.set(type, set);
			}
			set.add(handler);
			return () => set?.delete(handler);
		},
		joinRoom: () => {},
		leaveRoom: () => {},
	}),
}));

let latest: ReturnType<typeof useChat>;

function Probe({ active }: { active: boolean }) {
	latest = useChat(active);
	return null;
}

let latestUnread: number;

function UnreadProbe({ chatOpen }: { chatOpen: boolean }) {
	latestUnread = useCeoUnread(chatOpen);
	return null;
}

function mount(active = false) {
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
	});
	qc.setQueryData(queryKeys.chatConversation(), {
		conversation_id: 'convo-1',
		messages: [],
		compacted_count: 0,
	});
	const utils = render(
		<QueryClientProvider client={qc}>
			<Probe active={active} />
		</QueryClientProvider>,
	);
	return { qc, ...utils };
}

function mountUnread(chatOpen = false) {
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
	});
	const utils = render(
		<QueryClientProvider client={qc}>
			<UnreadProbe chatOpen={chatOpen} />
		</QueryClientProvider>,
	);
	return { qc, ...utils };
}

const completeEvent = (id: string, extra: Record<string, unknown> = {}) => ({
	type: WsMessageType.ChatMessageComplete,
	conversationId: 'convo-1',
	messageId: id,
	status: ChatMessageStatus.Complete,
	content: 'done',
	inputTokens: 0,
	outputTokens: 0,
	costCents: 0,
	...extra,
});

beforeEach(() => {
	socket.handlers.clear();
	localStorage.removeItem('hezo_chat_unread');
	// A conversation with messages marks itself read on a fire-and-forget POST.
	// Unmocked it outlives the test and dials the real port, so a green run logs
	// a connection error per test. No test here asserts on a post.
	vi.spyOn(api, 'post').mockResolvedValue({});
});

afterEach(() => {
	vi.restoreAllMocks();
	localStorage.removeItem('hezo_chat_unread');
});

test('start/delta/complete events fold into the conversation cache in order', async () => {
	// The message list is query data, and a disabled (inactive) query observer
	// doesn't re-render on cache patches — so run this one with the chat open,
	// serving the initial history through a stubbed api.get (the harness backend
	// has no ChatSessionManager).
	vi.spyOn(api, 'get').mockResolvedValue({
		conversation_id: 'convo-1',
		messages: [],
		compacted_count: 0,
	});
	mount(true);
	await waitFor(() => expect(latest.loaded).toBe(true));

	// The query-cache → observer notification lands on a scheduled task, so each
	// emit is followed by a waitFor on the hook's re-rendered state.

	// An assistant reply starts streaming with its first chunk.
	act(() => {
		socket.emit(WsMessageType.ChatMessageStart, {
			type: WsMessageType.ChatMessageStart,
			conversationId: 'convo-1',
			messageId: 'm1',
			role: 'assistant',
			channel: 'web',
			content: 'Hel',
			createdAt: '2026-07-06T10:00:00.000Z',
		});
	});
	await waitFor(() => expect(latest.messages).toHaveLength(1));
	expect(latest.messages[0]).toMatchObject({ id: 'm1', status: 'streaming', content: 'Hel' });
	expect(latest.streaming).toBe(true);

	// Deltas accumulate onto the streaming bubble; a duplicate start for the same
	// id is ignored (no double bubble), and another conversation's delta never
	// lands here.
	act(() => {
		socket.emit(WsMessageType.ChatMessageStart, {
			type: WsMessageType.ChatMessageStart,
			conversationId: 'convo-1',
			messageId: 'm1',
			role: 'assistant',
			channel: 'web',
			content: 'Hel',
			createdAt: '2026-07-06T10:00:00.000Z',
		});
		socket.emit(WsMessageType.ChatMessageDelta, {
			type: WsMessageType.ChatMessageDelta,
			conversationId: 'convo-1',
			messageId: 'm1',
			text: 'lo the',
		});
		socket.emit(WsMessageType.ChatMessageDelta, {
			type: WsMessageType.ChatMessageDelta,
			conversationId: 'other-convo',
			messageId: 'm1',
			text: 'INTRUDER',
		});
		socket.emit(WsMessageType.ChatMessageDelta, {
			type: WsMessageType.ChatMessageDelta,
			conversationId: 'convo-1',
			messageId: 'm1',
			text: 're',
		});
	});
	await waitFor(() => expect(latest.messages[0]?.content).toBe('Hello there'));
	expect(latest.messages).toHaveLength(1);

	// A user message (echoed from another surface) lands as complete immediately.
	act(() => {
		socket.emit(WsMessageType.ChatMessageStart, {
			type: WsMessageType.ChatMessageStart,
			conversationId: 'convo-1',
			messageId: 'u1',
			role: 'user',
			channel: 'web',
			content: 'thanks',
			createdAt: '2026-07-06T10:00:01.000Z',
		});
	});
	await waitFor(() => expect(latest.messages).toHaveLength(2));
	expect(latest.messages[1]).toMatchObject({ id: 'u1', role: 'user', status: 'complete' });

	// Complete finalizes content + status, ends the streaming state, and carries
	// the agent's suggested quick replies onto the stored row.
	act(() => {
		socket.emit(
			WsMessageType.ChatMessageComplete,
			completeEvent('m1', { content: 'Hello there!', suggestedReplies: ['Yes', 'Not yet'] }),
		);
	});
	await waitFor(() =>
		expect(latest.messages[0]).toMatchObject({
			content: 'Hello there!',
			status: 'complete',
			suggested_replies: ['Yes', 'Not yet'],
		}),
	);
	expect(latest.streaming).toBe(false);
});

test('a CEO reply completing while the dock is closed badges the monogram and persists', () => {
	mountUnread(false);

	act(() => socket.emit(WsMessageType.ChatMessageComplete, completeEvent('m1')));
	expect(latestUnread).toBe(1);
	expect(localStorage.getItem('hezo_chat_unread')).toBe('1');

	act(() => socket.emit(WsMessageType.ChatMessageComplete, completeEvent('m2')));
	expect(latestUnread).toBe(2);
	expect(localStorage.getItem('hezo_chat_unread')).toBe('2');
});

test('a persisted unread tally is restored on mount and cleared when the dock opens', () => {
	localStorage.setItem('hezo_chat_unread', '5');
	const { qc, rerender } = mountUnread(false);
	expect(latestUnread).toBe(5);

	// Opening the dock reads the stream → tally drops to zero.
	rerender(
		<QueryClientProvider client={qc}>
			<UnreadProbe chatOpen={true} />
		</QueryClientProvider>,
	);
	expect(latestUnread).toBe(0);
	expect(localStorage.getItem('hezo_chat_unread')).toBeNull();
});

test('a reply completing while the dock is open does not badge', async () => {
	mountUnread(true);
	await act(async () => {
		socket.emit(WsMessageType.ChatMessageComplete, completeEvent('m1'));
	});
	expect(latestUnread).toBe(0);
	expect(localStorage.getItem('hezo_chat_unread')).toBeNull();
});

test('a compaction event refetches the conversation window', async () => {
	const { qc } = mount(false);
	const invalidate = vi.spyOn(qc, 'invalidateQueries');
	await act(async () => {
		socket.emit(WsMessageType.ChatCompacted, {
			type: WsMessageType.ChatCompacted,
			conversationId: 'convo-1',
		});
	});
	expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.chatConversation() });
});

test('a throwing localStorage (private mode) degrades gracefully on read and write', async () => {
	// Read side: a storage that throws yields unread 0 instead of crashing mount.
	const getSpy = vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
		throw new Error('denied');
	});
	const setSpy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
		throw new Error('denied');
	});
	mountUnread(false);
	expect(latestUnread).toBe(0);

	// Write side: badging still updates React state even when persistence fails.
	await act(async () => {
		socket.emit(WsMessageType.ChatMessageComplete, completeEvent('m1'));
	});
	expect(latestUnread).toBe(1);
	getSpy.mockRestore();
	setSpy.mockRestore();
});

// --- Signal-room preview frames (the 140-char truncation bug) ---------------
//
// A project room's events fan to TWO rooms: the conversation's own (full body)
// and the team signal room (a CHAT_MESSAGE_PREVIEW_CHARS slice, for list rows).
// A room's FIRST message creates the conversation, so at that moment the dock
// has only joined the team room - and rows dedupe on first write, so a slice
// applied then would never be repaired. These two lock that down.

const LONG_MESSAGE =
	'The X Engagement agent should only be used for fetching data from X, and if we are ' +
	'aiming for e.g 20-30 tweets to reply to then it should fetch enough of them in one ' +
	'pass rather than paging one tweet at a time.';
const PREVIEW_SLICE = LONG_MESSAGE.slice(0, 140);

test('a preview start frame anchors the room but never renders its slice as the message', async () => {
	// The server row, as the REST read serves it once the conversation exists.
	let serverMessages: unknown[] = [];
	vi.spyOn(api, 'get').mockImplementation(async () => ({
		conversation_id: 'convo-1',
		messages: serverMessages,
		compacted_count: 0,
	}));
	mount(true);
	await waitFor(() => expect(latest.loaded).toBe(true));

	serverMessages = [
		{
			id: 'u1',
			role: 'user',
			channel: 'web',
			status: ChatMessageStatus.Complete,
			content: LONG_MESSAGE,
			created_at: '2026-07-06T10:00:00.000Z',
		},
	];

	act(() => {
		socket.emit(WsMessageType.ChatMessageStart, {
			type: WsMessageType.ChatMessageStart,
			conversationId: 'convo-1',
			messageId: 'u1',
			role: 'user',
			channel: 'web',
			content: PREVIEW_SLICE,
			createdAt: '2026-07-06T10:00:00.000Z',
			preview: true,
		});
	});

	// The refetch the preview frame triggers supplies the whole row.
	await waitFor(() => expect(latest.messages).toHaveLength(1));
	expect(latest.messages[0]?.content).toBe(LONG_MESSAGE);
	// The specific regression: the slice must never have been written, because a
	// first-write-wins insert would pin it there for the life of the thread.
	expect(latest.messages[0]?.content).not.toBe(PREVIEW_SLICE);
});

test('a preview complete frame does not truncate a reply that already arrived whole', async () => {
	vi.spyOn(api, 'get').mockResolvedValue({
		conversation_id: 'convo-1',
		messages: [],
		compacted_count: 0,
	});
	mount(true);
	await waitFor(() => expect(latest.loaded).toBe(true));

	// The untruncated copy, over the conversation's own room.
	act(() => {
		socket.emit(WsMessageType.ChatMessageStart, {
			type: WsMessageType.ChatMessageStart,
			conversationId: 'convo-1',
			messageId: 'a1',
			role: 'assistant',
			channel: 'web',
			content: '',
			createdAt: '2026-07-06T10:00:00.000Z',
		});
		socket.emit(WsMessageType.ChatMessageComplete, completeEvent('a1', { content: LONG_MESSAGE }));
	});
	await waitFor(() => expect(latest.messages[0]?.content).toBe(LONG_MESSAGE));

	// The signal-room copy of the same completion lands second. Completion
	// OVERWRITES content, so an unguarded apply would cut the settled reply.
	act(() => {
		socket.emit(
			WsMessageType.ChatMessageComplete,
			completeEvent('a1', { content: PREVIEW_SLICE, preview: true }),
		);
	});
	await waitFor(() => expect(latest.streaming).toBe(false));
	expect(latest.messages[0]?.content).toBe(LONG_MESSAGE);
});
