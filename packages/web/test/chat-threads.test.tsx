import type { ChatConversationSummary, ChatMessage } from '@hezo/web/hooks/use-chat';
import { queryClient } from '@hezo/web/lib/query-client';
import { queryKeys } from '@hezo/web/lib/query-keys';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';

// The component harness has no ChatSessionManager (chat endpoints 503), so we seed
// the query caches the hooks read from — `useChat` keys history by conversation id
// (staleTime Infinity, so a seeded thread never refetches), and
// `useChatConversations` drives the switcher list. This asserts the switcher
// re-keys the chatbox to the selected thread.

const now = () => new Date().toISOString();

function msg(id: string, content: string): ChatMessage {
	return { id, role: 'assistant', channel: 'web', status: 'complete', content, created_at: now() };
}

function thread(id: string, title: string | null): ChatConversationSummary {
	return {
		id,
		channel: 'web',
		external_thread_id: null,
		title,
		last_activity_at: now(),
		closed_at: null,
		channels: ['web'],
	};
}

function seedThreads() {
	queryClient.setQueryData(queryKeys.chatConversations(), {
		conversations: [thread('thread-1', 'First'), thread('thread-2', 'Second')],
	});
	// The default web thread (no id passed) resolves to thread-1.
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

test('the thread switcher re-keys the chatbox to the selected conversation', async () => {
	seedThreads();
	const { findByTestId, getByTestId, getByText, findByText, queryByText, user } = await renderApp({
		initialPath: '/home',
	});

	(await findByTestId('chat-launcher')).click();
	await findByTestId('chat-panel');

	// The switcher renders with both web threads, first thread active + its messages.
	const select = (await findByTestId('chat-thread-select')) as HTMLSelectElement;
	expect(select.value).toBe('thread-1');
	expect(getByText('hello from the first thread')).toBeTruthy();
	expect(queryByText('hello from the second thread')).toBeNull();

	// Switching to the second thread swaps the chatbox to that thread's history.
	await user.selectOptions(select, 'thread-2');
	expect(await findByText('hello from the second thread')).toBeTruthy();
	expect(queryByText('hello from the first thread')).toBeNull();

	// A new-thread affordance is present.
	expect(getByTestId('chat-thread-new')).toBeTruthy();
});

test('an untitled thread renders as "New thread" (not "Main"); a titled thread shows its title', async () => {
	// The first thread is untitled (title null) — it must read "New thread", not the
	// old hardcoded "Main". The CEO fills the title in later.
	queryClient.setQueryData(queryKeys.chatConversations(), {
		conversations: [thread('thread-1', null), thread('thread-2', 'Roadmap planning')],
	});
	queryClient.setQueryData(queryKeys.chatConversation(), {
		conversation_id: 'thread-1',
		messages: [msg('m1', 'hi')],
		compacted_count: 0,
	});

	const { findByTestId } = await renderApp({ initialPath: '/home' });
	(await findByTestId('chat-launcher')).click();
	await findByTestId('chat-panel');

	const select = (await findByTestId('chat-thread-select')) as HTMLSelectElement;
	const labels = Array.from(select.options).map((o) => o.textContent?.trim());
	expect(labels).toContain('New thread');
	expect(labels).toContain('Roadmap planning');
	expect(labels).not.toContain('Main');
});
