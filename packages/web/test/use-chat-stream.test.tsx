// Coverage for the WS-streamed side of use-chat.ts. The component harness
// stubs WebSocket to a no-op, so the subscribe handlers (message start / delta /
// complete / compacted) never fire in the widget specs. Here the socket context
// itself is mocked with a controllable emitter and the hook is driven directly:
// events are emitted and the hook's derived state (messages, streaming, unread)
// is asserted, plus the localStorage-persisted unread tally and its
// private-mode (throwing storage) fallbacks.

import { ChatMessageStatus, WsMessageType } from '@hezo/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useChat } from '../src/hooks/use-chat';
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

beforeEach(() => {
	socket.handlers.clear();
	localStorage.removeItem('hezo_chat_unread');
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
	// id is ignored (no double bubble).
	act(() => {
		socket.emit(WsMessageType.ChatMessageStart, {
			type: WsMessageType.ChatMessageStart,
			messageId: 'm1',
			role: 'assistant',
			channel: 'web',
			content: 'Hel',
			createdAt: '2026-07-06T10:00:00.000Z',
		});
		socket.emit(WsMessageType.ChatMessageDelta, {
			type: WsMessageType.ChatMessageDelta,
			messageId: 'm1',
			text: 'lo the',
		});
		socket.emit(WsMessageType.ChatMessageDelta, {
			type: WsMessageType.ChatMessageDelta,
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
			messageId: 'u1',
			role: 'user',
			channel: 'web',
			content: 'thanks',
			createdAt: '2026-07-06T10:00:01.000Z',
		});
	});
	await waitFor(() => expect(latest.messages).toHaveLength(2));
	expect(latest.messages[1]).toMatchObject({ id: 'u1', role: 'user', status: 'complete' });

	// Complete finalizes content + status and ends the streaming state.
	act(() => {
		socket.emit(WsMessageType.ChatMessageComplete, {
			type: WsMessageType.ChatMessageComplete,
			messageId: 'm1',
			status: ChatMessageStatus.Complete,
			content: 'Hello there!',
			inputTokens: 1,
			outputTokens: 2,
			costCents: 0,
		});
	});
	await waitFor(() =>
		expect(latest.messages[0]).toMatchObject({ content: 'Hello there!', status: 'complete' }),
	);
	expect(latest.streaming).toBe(false);
});

test('a reply completing while the widget is closed badges unread and persists the tally', () => {
	mount(false);

	const complete = (id: string) =>
		socket.emit(WsMessageType.ChatMessageComplete, {
			type: WsMessageType.ChatMessageComplete,
			messageId: id,
			status: ChatMessageStatus.Complete,
			content: 'done',
			inputTokens: 0,
			outputTokens: 0,
			costCents: 0,
		});

	act(() => complete('m1'));
	expect(latest.unread).toBe(1);
	expect(localStorage.getItem('hezo_chat_unread')).toBe('1');

	act(() => complete('m2'));
	expect(latest.unread).toBe(2);
	expect(localStorage.getItem('hezo_chat_unread')).toBe('2');
});

test('a persisted unread tally is restored on mount and cleared when the chat opens', () => {
	localStorage.setItem('hezo_chat_unread', '5');
	const { qc, rerender } = mount(false);
	expect(latest.unread).toBe(5);

	// Opening the chat (active=true) reads the thread → tally drops to zero.
	rerender(
		<QueryClientProvider client={qc}>
			<Probe active={true} />
		</QueryClientProvider>,
	);
	expect(latest.unread).toBe(0);
	expect(localStorage.getItem('hezo_chat_unread')).toBeNull();
});

test('a reply completing while the chat is open does not badge', async () => {
	mount(true);
	await act(async () => {
		socket.emit(WsMessageType.ChatMessageComplete, {
			type: WsMessageType.ChatMessageComplete,
			messageId: 'm1',
			status: ChatMessageStatus.Complete,
			content: 'done',
			inputTokens: 0,
			outputTokens: 0,
			costCents: 0,
		});
	});
	expect(latest.unread).toBe(0);
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
	mount(false);
	expect(latest.unread).toBe(0);

	// Write side: badging still updates React state even when persistence fails.
	await act(async () => {
		socket.emit(WsMessageType.ChatMessageComplete, {
			type: WsMessageType.ChatMessageComplete,
			messageId: 'm1',
			status: ChatMessageStatus.Complete,
			content: 'done',
			inputTokens: 0,
			outputTokens: 0,
			costCents: 0,
		});
	});
	expect(latest.unread).toBe(1);
	getSpy.mockRestore();
	setSpy.mockRestore();
});
