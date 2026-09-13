import type { ChatConversationSummary, ChatMessage } from '@hezo/web/hooks/use-chat';
import { queryClient } from '@hezo/web/lib/query-client';
import { queryKeys } from '@hezo/web/lib/query-keys';
import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { currentRoomValue, selectRoom } from './helpers/chat-switcher';
import { renderApp } from './helpers/render';

// Which room the dock lands on. Every surface that opens it names the room it
// wants - the header monogram the CEO, a project card its own DM - so the CEO
// button always reaches the CEO, and a room that has since disappeared falls
// back rather than stranding the dock on a conversation that reads fine and
// rejects every send. Nothing here needs a real layout pass or a live
// WebSocket, so it stays a component test (decision tree: none of 1-6 apply).
// Like chat-threads.test.tsx, the harness has no ChatSessionManager (chat
// endpoints 503), so the query caches the hooks read from are seeded directly.

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

test('a selected thread that disappears falls back to the CEO stream', async () => {
	// The thread the dock is on leaves the list (closed elsewhere, deleted, or
	// its agent fired). The server would still serve its history by id, so the
	// dock would sit on a room that reads fine and rejects every send.
	seedRooms();
	const { findByTestId, findByText, user } = await renderApp({ initialPath: '/home' });

	(await findByTestId('app-header-chat')).click();
	await selectRoom(user, 'thread:thread-2');
	expect(await findByText('hello from the telegram dm')).toBeTruthy();

	queryClient.setQueryData(queryKeys.chatConversations(), { conversations: [] });

	await waitFor(() => expect(currentRoomValue()).toBe('ceo'));
	expect(await findByText('hello from the live stream')).toBeTruthy();
});

test('the CEO monogram opens the CEO, not the room the dock was last left in', async () => {
	// The monogram carries the CEO's name and the CEO's unread badge, so it is
	// the CEO's button. The dock used to reopen on whichever room was last
	// selected, which meant clicking CEO could land you in an agent DM.
	// A stale key left by an instance upgrading from that release must not
	// resurrect the behaviour, so seed one and assert it changes nothing.
	localStorage.setItem('hezo_chat_room', JSON.stringify({ kind: 'thread', id: 'thread-2' }));
	queryClient.setQueryData(queryKeys.chatConversations(), {
		conversations: [thread('thread-2', 'Ops', { channel: 'telegram', external_thread_id: '999' })],
	});
	queryClient.setQueryData(queryKeys.chatConversation(), {
		conversation_id: 'ceo-live',
		messages: [msg('m1', 'hello from the live stream')],
		compacted_count: 0,
	});
	queryClient.setQueryData(queryKeys.chatConversation('thread-2'), {
		conversation_id: 'thread-2',
		messages: [msg('m2', 'hello from the telegram dm')],
		compacted_count: 0,
	});

	const { findByTestId, findByText, queryByText } = await renderApp({ initialPath: '/home' });
	(await findByTestId('app-header-chat')).click();
	await findByTestId('chat-panel');

	await waitFor(() => expect(currentRoomValue()).toBe('ceo'));
	expect(await findByText('hello from the live stream')).toBeTruthy();
	expect(queryByText('hello from the telegram dm')).toBeNull();
});
