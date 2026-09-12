import type {
	ChatConversationSummary,
	ChatConvertedTaskRef,
	ChatMessage,
} from '@hezo/web/hooks/use-chat';
import { queryClient } from '@hezo/web/lib/query-client';
import { queryKeys } from '@hezo/web/lib/query-keys';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';

// Threads converted to tasks under the old whole-thread convert stay readable as
// History records: the in-thread meta marker and the composer banner both link
// the task, and the composer locks. The component harness has no
// ChatSessionManager (chat endpoints 503), so thread/message caches are seeded
// directly, as in chat-threads.test.tsx. No layout pass, live WebSocket, or
// gate flow is involved (decision tree: none of 1-6 apply), so this stays a
// component test.

const now = () => new Date().toISOString();

const TASK: ChatConvertedTaskRef = {
	id: 'task-1',
	identifier: 'WEB-12',
	title: 'Landing page hero rewrite',
	project_slug: 'website',
};

function msg(id: string, content: string, role: ChatMessage['role'] = 'assistant'): ChatMessage {
	return { id, role, channel: 'web', status: 'complete', content, created_at: now() };
}

function convertedThread(): ChatConversationSummary {
	return {
		id: 'thread-1',
		channel: 'web',
		external_thread_id: null,
		kind: 'assistant',
		title: 'Landing page revamp',
		last_activity_at: now(),
		closed_at: now(),
		converted_task_id: TASK.id,
		converted_task: TASK,
	};
}

function seedConvertedThread(messages: ChatMessage[]) {
	queryClient.setQueryData(queryKeys.chatConversations(), {
		conversations: [convertedThread()],
	});
	queryClient.setQueryData(queryKeys.chatConversation(), {
		conversation_id: 'ceo-live',
		messages: [msg('m0', 'live stream')],
		compacted_count: 0,
	});
	queryClient.setQueryData(queryKeys.chatConversation('thread-1'), {
		conversation_id: 'thread-1',
		messages,
		compacted_count: 0,
	});
}

test('a converted History thread renders the meta message, banner link and locked composer', async () => {
	seedConvertedThread([
		msg('m1', 'The hero feels stale', 'user'),
		msg('m2', 'Agreed, let us make it a task.'),
		{
			...msg('m3', 'Conversation converted to task WEB-12: Landing page hero rewrite', 'system'),
			system_kind: 'converted_task' as ChatMessage['system_kind'],
		},
	]);
	const { findByTestId, findAllByTestId, getByTestId, user } = await renderApp({
		initialPath: '/home',
	});
	(await findByTestId('app-header-chat')).click();
	await findByTestId('chat-panel');

	// The converted thread lists under History; select it.
	const select = (await findByTestId('chat-room-select')) as HTMLSelectElement;
	await user.selectOptions(select, 'thread:thread-1');

	// The task link renders twice — the in-thread meta marker and the composer
	// banner — both pointing at the task page.
	const links = await findAllByTestId('chat-converted-task-link');
	expect(links.length).toBe(2);
	for (const link of links) {
		expect((link as HTMLAnchorElement).getAttribute('href')).toBe('/projects/website/tasks/web-12');
	}
	// The system row renders as a centred meta marker, not a user bubble.
	const systemRow = document.querySelector('[data-testid="chat-message"][data-role="system"]');
	expect(systemRow).toBeTruthy();
	expect(systemRow?.querySelector('[data-testid="chat-converted-task-link"]')).toBeTruthy();

	// The banner names the task; the composer is locked with the converted
	// placeholder (read `disabled` off the element — no jest-dom matchers).
	const banner = getByTestId('chat-converted-banner');
	expect(banner.textContent).toContain('WEB-12');
	const input = getByTestId('chat-input') as HTMLTextAreaElement;
	expect(input.disabled).toBe(true);
	expect(input.placeholder).toContain('WEB-12');
});

test('a handoff warning in a converted thread stays a warning, not a second task link', async () => {
	// The regression the message-level `system_kind` exists to prevent: the
	// converted marker is chosen by the THREAD's converted-task reference, so
	// without a discriminator every system row in a converted thread rendered as
	// that link — including a warning written before the conversion.
	seedConvertedThread([
		msg('m1', 'The hero feels stale', 'user'),
		{
			...msg('w1', 'This chat turn woke no one on WEB-9. It named **captain** there.', 'system'),
			system_kind: 'handoff_not_delivered' as ChatMessage['system_kind'],
		},
		{
			...msg('m3', 'Conversation converted to task WEB-12: Landing page hero rewrite', 'system'),
			system_kind: 'converted_task' as ChatMessage['system_kind'],
		},
	]);

	const { findByTestId, findAllByTestId, user } = await renderApp({ initialPath: '/home' });
	(await findByTestId('app-header-chat')).click();
	await findByTestId('chat-panel');
	const select = (await findByTestId('chat-room-select')) as HTMLSelectElement;
	await user.selectOptions(select, 'thread:thread-1');

	// The converted marker still links the task (in-thread + composer banner)…
	const links = await findAllByTestId('chat-converted-task-link');
	expect(links.length).toBe(2);
	// …while the warning keeps its own text and never becomes a task link.
	const warningRow = document.querySelector('[data-system-kind="handoff_not_delivered"]');
	expect(warningRow).toBeTruthy();
	expect(warningRow?.textContent).toContain('WEB-9');
	expect(warningRow?.querySelector('[data-testid="chat-converted-task-link"]')).toBeNull();
});
