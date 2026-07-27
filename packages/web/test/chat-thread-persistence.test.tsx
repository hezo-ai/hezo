import type { ChatConversationSummary, ChatMessage } from '@hezo/web/hooks/use-chat';
import { queryClient } from '@hezo/web/lib/query-client';
import { queryKeys } from '@hezo/web/lib/query-keys';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';

// The chatbox remembers the thread you switched to, so closing and reopening it
// — or a reload, or the remount a bare route forces — resumes that conversation
// instead of snapping back to the server's default web thread. Nothing here
// needs a real layout pass or a live WebSocket, so it stays a component test
// (decision tree: none of 1-6 apply). Like chat-threads.test.tsx, the harness has
// no ChatSessionManager (chat endpoints 503), so the query caches the hooks read
// from are seeded directly.

const now = () => new Date().toISOString();

function msg(id: string, content: string): ChatMessage {
	return { id, role: 'assistant', channel: 'web', status: 'complete', content, created_at: now() };
}

function thread(id: string, title: string | null): ChatConversationSummary {
	return {
		id,
		channel: 'web',
		external_thread_id: null,
		kind: 'assistant',
		title,
		last_activity_at: now(),
		closed_at: null,
	};
}

/** thread-1 is the server's default web thread; thread-2 is a second thread. */
function seedThreads(threads = [thread('thread-1', 'First'), thread('thread-2', 'Second')]) {
	queryClient.setQueryData(queryKeys.chatConversations(), { conversations: threads });
	queryClient.setQueryData(queryKeys.chatConversation(), {
		conversation_id: 'thread-1',
		messages: [msg('m1', 'hello from the first thread')],
		compacted_count: 0,
	});
	queryClient.setQueryData(queryKeys.chatConversation('thread-2'), {
		conversation_id: 'thread-2',
		messages: [msg('m2', 'hello from the second thread')],
		compacted_count: 0,
	});
}

test('switching threads is remembered, and a later open resumes that thread', async () => {
	seedThreads();
	const { findByTestId, findByText, user } = await renderApp({ initialPath: '/home' });

	(await findByTestId('chat-launcher')).click();
	const select = (await findByTestId('chat-thread-select')) as HTMLSelectElement;
	expect(select.value).toBe('thread-1');

	await user.selectOptions(select, 'thread-2');
	expect(await findByText('hello from the second thread')).toBeTruthy();

	// The switch is durable, not just component state: it survives a full remount
	// of the app shell (what a reload or a bare-route round trip produces).
	expect(localStorage.getItem('hezo_chat_thread')).toBe('thread-2');
});

test('a remembered thread is restored on mount instead of the default thread', async () => {
	localStorage.setItem('hezo_chat_thread', 'thread-2');
	seedThreads();
	const { findByTestId, findByText, queryByText } = await renderApp({ initialPath: '/home' });

	(await findByTestId('chat-launcher')).click();

	// Opens straight into the remembered thread — the default thread's history is
	// never shown.
	expect(await findByText('hello from the second thread')).toBeTruthy();
	expect(queryByText('hello from the first thread')).toBeNull();
	const select = (await findByTestId('chat-thread-select')) as HTMLSelectElement;
	expect(select.value).toBe('thread-2');
});

test('a remembered thread that is no longer open falls back to the default thread', async () => {
	// The remembered thread was closed since (here, in another tab, or on its own
	// platform) so it is gone from the list. The server would still serve its
	// history by id, which would restore a thread that reads fine but rejects every
	// send — so the stale id must be dropped rather than used.
	localStorage.setItem('hezo_chat_thread', 'thread-gone');
	seedThreads([thread('thread-1', 'First'), thread('thread-2', 'Second')]);
	const { findByTestId, findByText } = await renderApp({ initialPath: '/home' });

	(await findByTestId('chat-launcher')).click();

	expect(await findByText('hello from the first thread')).toBeTruthy();
	const select = (await findByTestId('chat-thread-select')) as HTMLSelectElement;
	expect(select.value).toBe('thread-1');
	expect(localStorage.getItem('hezo_chat_thread')).toBeNull();
});
