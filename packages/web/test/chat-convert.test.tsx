import type {
	ChatConversationSummary,
	ChatConvertedTaskRef,
	ChatMessage,
} from '@hezo/web/hooks/use-chat';
import { queryClient } from '@hezo/web/lib/query-client';
import { queryKeys } from '@hezo/web/lib/query-keys';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedProject, seedWorkspace } from './helpers/seed';

// Convert-a-conversation-to-a-task, web side. The component harness has no
// ChatSessionManager (chat endpoints 503), so thread/message caches are seeded
// directly, as in chat-threads.test.tsx; the convert round trip itself is
// server-tier coverage (chat-convert-to-task.test.ts). No layout pass, live
// WebSocket, or gate flow is involved (decision tree: none of 1-6 apply), so
// this stays a component test.

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

function seedConvertedThread() {
	queryClient.setQueryData(queryKeys.chatConversations(), {
		conversations: [
			thread('thread-1', 'Landing page revamp', {
				closed_at: now(),
				converted_task_id: TASK.id,
				converted_task: TASK,
			}),
			thread('thread-2', 'Other'),
		],
	});
	queryClient.setQueryData(queryKeys.chatConversation(), {
		conversation_id: 'thread-1',
		messages: [
			msg('m1', 'The hero feels stale', 'user'),
			msg('m2', 'Agreed, let us make it a task.'),
			msg('m3', 'Conversation converted to task WEB-12: Landing page hero rewrite', 'system'),
		],
		compacted_count: 0,
	});
}

test('a converted thread renders the meta message, banner link, locked composer, and no close ✕', async () => {
	seedConvertedThread();
	const { findByTestId, findAllByTestId, getByTestId, queryByTestId } = await renderApp({
		initialPath: '/home',
	});
	(await findByTestId('chat-launcher')).click();
	await findByTestId('chat-panel');

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

	// No convert affordance (already converted) and no close ✕ for this thread.
	expect(queryByTestId('chat-convert')).toBeNull();
	expect(queryByTestId('chat-thread-close')).toBeNull();
});

test('the convert action opens a dialog listing real projects, hidden for coworker threads', async () => {
	let projectName = '';
	const { findByTestId, queryByTestId, user } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Demo Site' });
			projectName = project.name;
		},
	});

	queryClient.setQueryData(queryKeys.chatConversations(), {
		conversations: [
			thread('thread-1', 'Landing page revamp'),
			thread('thread-4', '#product', {
				channel: 'slack',
				external_thread_id: 'C42:1',
				kind: 'coworker',
			}),
		],
	});
	queryClient.setQueryData(queryKeys.chatConversation(), {
		conversation_id: 'thread-1',
		messages: [msg('m1', 'hello')],
		compacted_count: 0,
	});
	queryClient.setQueryData(queryKeys.chatConversation('thread-4'), {
		conversation_id: 'thread-4',
		messages: [msg('m4', 'channel chatter')],
		compacted_count: 0,
	});

	(await findByTestId('chat-launcher')).click();
	await findByTestId('chat-panel');

	// The header offers convert on the active assistant web thread; the dialog
	// carries the project picker (real in-process projects API) and the title
	// prefilled from the thread.
	(await findByTestId('chat-convert')).click();
	const dialog = await findByTestId('chat-convert-dialog');
	expect(dialog).toBeTruthy();
	// Radix portals render into document.body, so query there.
	const select = document.querySelector(
		'[data-testid="chat-convert-project"]',
	) as HTMLSelectElement;
	const labels = Array.from(select.options).map((o) => o.textContent?.trim());
	expect(labels).toContain(projectName);
	const title = document.querySelector('[data-testid="chat-convert-title"]') as HTMLInputElement;
	expect(title.value).toBe('Landing page revamp');
	// Submit stays disabled until a project is picked.
	const submit = document.querySelector('[data-testid="chat-convert-submit"]') as HTMLButtonElement;
	expect(submit.disabled).toBe(true);
	(
		document.querySelector('[data-testid="chat-convert-dialog"] button[aria-label]') as
			| HTMLButtonElement
			| undefined
	)?.click();

	// A coworker thread gets no convert affordance.
	const threadSelect = (await findByTestId('chat-thread-select')) as HTMLSelectElement;
	await user.selectOptions(threadSelect, 'thread-4');
	await findByTestId('chat-readonly-banner');
	expect(queryByTestId('chat-convert')).toBeNull();
});
