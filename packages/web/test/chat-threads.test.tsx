import type { ChatConversationSummary, ChatMessage } from '@hezo/web/hooks/use-chat';
import { queryClient } from '@hezo/web/lib/query-client';
import { queryKeys } from '@hezo/web/lib/query-keys';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';

// The component harness has no ChatSessionManager (chat endpoints 503), so we seed
// the query caches the hooks read from — `useChat` keys history by room
// (staleTime Infinity, so a seeded room never refetches), and
// `useChatConversations` drives the switcher list. This asserts the dock's room
// switcher: the pinned CEO stream on top, external DMs, read-only linked
// channels, and closed threads under History.

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

test('the room switcher re-keys the dock to the selected conversation', async () => {
	queryClient.setQueryData(queryKeys.chatConversations(), {
		conversations: [thread('thread-2', 'Ops', { channel: 'telegram', external_thread_id: '999' })],
	});
	// The pinned CEO entry resolves to the live stream server-side (no id passed).
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

	const { findByTestId, getByText, findByText, queryByText, user } = await renderApp({
		initialPath: '/home',
	});

	(await findByTestId('app-header-chat')).click();
	await findByTestId('chat-panel');

	// The switcher opens on the pinned CEO stream and shows its messages.
	const select = (await findByTestId('chat-room-select')) as HTMLSelectElement;
	expect(select.value).toBe('ceo');
	expect(getByText('hello from the live stream')).toBeTruthy();
	expect(queryByText('hello from the telegram dm')).toBeNull();

	// Switching to the external DM swaps the dock to that thread's history.
	await user.selectOptions(select, 'thread:thread-2');
	expect(await findByText('hello from the telegram dm')).toBeTruthy();
	expect(queryByText('hello from the live stream')).toBeNull();
});

test('open web threads are not listed - the live stream is the pinned CEO entry', async () => {
	// Single-stream: the CEO's open web thread IS the pinned entry; an untitled
	// external thread falls back to "New thread", and nothing says "Main".
	queryClient.setQueryData(queryKeys.chatConversations(), {
		conversations: [
			thread('thread-1', 'First'),
			thread('thread-2', null, { channel: 'telegram', external_thread_id: '7' }),
		],
	});
	queryClient.setQueryData(queryKeys.chatConversation(), {
		conversation_id: 'thread-1',
		messages: [msg('m1', 'hi')],
		compacted_count: 0,
	});

	const { findByTestId } = await renderApp({ initialPath: '/home' });
	(await findByTestId('app-header-chat')).click();
	await findByTestId('chat-panel');

	const select = (await findByTestId('chat-room-select')) as HTMLSelectElement;
	const labels = Array.from(select.options).map((o) => o.textContent?.trim());
	expect(labels[0]).toBe('CEO · HQ');
	// The open web thread is reached through the pinned CEO entry, not listed twice.
	expect(labels).not.toContain('First');
	expect(labels).toContain('New thread · TG DM');
	expect(labels).not.toContain('Main');
});

test('external and team-channel threads list with origin chips; coworker threads are read-only', async () => {
	queryClient.setQueryData(queryKeys.chatConversations(), {
		conversations: [
			thread('thread-1', 'Ops', { channel: 'telegram', external_thread_id: '999' }),
			thread('thread-2', 'Launch', { channel: 'slack', external_thread_id: 'D123' }),
			thread('thread-4', '#product', {
				channel: 'slack',
				external_thread_id: 'C42:1721.0001',
				kind: 'coworker',
			}),
		],
	});
	queryClient.setQueryData(queryKeys.chatConversation(), {
		conversation_id: 'ceo-live',
		messages: [msg('m1', 'hi')],
		compacted_count: 0,
	});
	queryClient.setQueryData(queryKeys.chatConversation('thread-4'), {
		conversation_id: 'thread-4',
		messages: [msg('m4', 'plan incoming')],
		compacted_count: 0,
	});

	const { findByTestId, user } = await renderApp({ initialPath: '/home' });
	(await findByTestId('app-header-chat')).click();
	await findByTestId('chat-panel');

	// Every surface's threads list, badged by their home channel; the coworker
	// thread sits in the "Linked channels" optgroup with the read-only lock.
	const select = (await findByTestId('chat-room-select')) as HTMLSelectElement;
	const labels = Array.from(select.options).map((o) => o.textContent?.trim());
	expect(labels).toContain('Ops · TG DM');
	expect(labels).toContain('Launch · SLACK DM');
	expect(labels).toContain('#product 🔒 · SLACK');
	const groups = Array.from(select.querySelectorAll('optgroup')).map((g) => g.label);
	expect(groups).toContain('Linked channels');
	expect(groups).toContain('External chats');

	// Selecting the coworker thread locks the composer and shows the banner.
	await user.selectOptions(select, 'thread:thread-4');
	const banner = await findByTestId('chat-readonly-banner');
	expect(banner.textContent).toContain('#product');
	expect(banner.textContent).toContain('Slack');
	const input = (await findByTestId('chat-input')) as HTMLTextAreaElement;
	expect(input.disabled).toBe(true);
});

test('a closed thread lists under History, readable with a locked composer', async () => {
	queryClient.setQueryData(queryKeys.chatConversations(), {
		conversations: [thread('thread-9', 'Old planning', { closed_at: now() })],
	});
	queryClient.setQueryData(queryKeys.chatConversation(), {
		conversation_id: 'ceo-live',
		messages: [msg('m1', 'hi')],
		compacted_count: 0,
	});
	queryClient.setQueryData(queryKeys.chatConversation('thread-9'), {
		conversation_id: 'thread-9',
		messages: [msg('m9', 'what we decided back then')],
		compacted_count: 0,
	});

	const { findByTestId, findByText, user } = await renderApp({ initialPath: '/home' });
	(await findByTestId('app-header-chat')).click();
	await findByTestId('chat-panel');

	const select = (await findByTestId('chat-room-select')) as HTMLSelectElement;
	const groups = Array.from(select.querySelectorAll('optgroup')).map((g) => g.label);
	expect(groups).toContain('History');

	// The old conversation stays fully readable; the composer locks (the live
	// conversation continues in the pinned stream).
	await user.selectOptions(select, 'thread:thread-9');
	expect(await findByText('what we decided back then')).toBeTruthy();
	expect(await findByTestId('chat-history-banner')).toBeTruthy();
	const input = (await findByTestId('chat-input')) as HTMLTextAreaElement;
	expect(input.disabled).toBe(true);
	expect(input.placeholder).toBe('Closed conversation');
});
