import type { ChatConversationSummary, ChatMessage } from '@hezo/web/hooks/use-chat';
import { queryClient } from '@hezo/web/lib/query-client';
import { queryKeys } from '@hezo/web/lib/query-keys';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';

// The dock remembers the room you switched to, so closing and reopening it
// — or a reload, or the remount a bare route forces — resumes that conversation
// instead of snapping back to the CEO stream. Nothing here needs a real layout
// pass or a live WebSocket, so it stays a component test (decision tree: none
// of 1-6 apply). Like chat-threads.test.tsx, the harness has no
// ChatSessionManager (chat endpoints 503), so the query caches the hooks read
// from are seeded directly.

const now = () => new Date().toISOString();

function msg(id: string, content: string): ChatMessage {
	return { id, role: 'assistant', channel: 'web', status: 'complete', content, created_at: now() };
}

function thread(
	id: string,
	title: string | null,
	overrides: Partial<ChatConversationSummary> = {},
): ChatConversationSummary {
	return {
		id,
		channel: 'web',
		external_thread_id: null,
		kind: 'assistant',
		title,
		last_activity_at: now(),
		closed_at: null,
		converted_task_id: null,
		converted_task: null,
		...overrides,
	};
}

/** The CEO live stream plus one external (Telegram) DM thread. */
function seedRooms(
	threads = [thread('thread-2', 'Ops', { channel: 'telegram', external_thread_id: '999' })],
) {
	queryClient.setQueryData(queryKeys.chatConversations(), { conversations: threads });
	queryClient.setQueryData(queryKeys.chatConversation(), {
		conversation_id: 'thread-1',
		messages: [msg('m1', 'hello from the live stream')],
		compacted_count: 0,
	});
	queryClient.setQueryData(queryKeys.chatConversation('thread-2'), {
		conversation_id: 'thread-2',
		messages: [msg('m2', 'hello from the telegram dm')],
		compacted_count: 0,
	});
}

test('switching rooms is remembered, and a later open resumes that room', async () => {
	seedRooms();
	const { findByTestId, findByText, user } = await renderApp({ initialPath: '/home' });

	(await findByTestId('app-header-chat')).click();
	const select = (await findByTestId('chat-room-select')) as HTMLSelectElement;
	expect(select.value).toBe('ceo');

	await user.selectOptions(select, 'thread:thread-2');
	expect(await findByText('hello from the telegram dm')).toBeTruthy();

	// The switch is durable, not just component state: it survives a full remount
	// of the app shell (what a reload or a bare-route round trip produces).
	expect(JSON.parse(localStorage.getItem('hezo_chat_room') ?? 'null')).toEqual({
		kind: 'thread',
		id: 'thread-2',
	});
});

test('a remembered room is restored on mount instead of the CEO stream', async () => {
	localStorage.setItem('hezo_chat_room', JSON.stringify({ kind: 'thread', id: 'thread-2' }));
	seedRooms();
	const { findByTestId, findByText, queryByText } = await renderApp({ initialPath: '/home' });

	(await findByTestId('app-header-chat')).click();

	// Opens straight into the remembered room — the stream's history is never shown.
	expect(await findByText('hello from the telegram dm')).toBeTruthy();
	expect(queryByText('hello from the live stream')).toBeNull();
	const select = (await findByTestId('chat-room-select')) as HTMLSelectElement;
	expect(select.value).toBe('thread:thread-2');
});

test('a remembered thread that no longer exists falls back to the CEO stream', async () => {
	// The remembered thread is gone from the list (deleted, or its agent removed).
	// The server would still serve its history by id, which would restore a room
	// that reads fine but rejects every send — so the stale id must be dropped
	// rather than used.
	localStorage.setItem('hezo_chat_room', JSON.stringify({ kind: 'thread', id: 'thread-gone' }));
	seedRooms();
	const { findByTestId, findByText } = await renderApp({ initialPath: '/home' });

	(await findByTestId('app-header-chat')).click();

	expect(await findByText('hello from the live stream')).toBeTruthy();
	const select = (await findByTestId('chat-room-select')) as HTMLSelectElement;
	expect(select.value).toBe('ceo');
	expect(localStorage.getItem('hezo_chat_room')).toBeNull();
});
