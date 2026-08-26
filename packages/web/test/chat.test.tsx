import type { ChatMessage } from '@hezo/web/hooks/use-chat';
import { toast } from '@hezo/web/hooks/use-toast';
import { queryClient } from '@hezo/web/lib/query-client';
import { queryKeys } from '@hezo/web/lib/query-keys';
import { fireEvent, waitFor, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';

// The component harness builds the backend without a ChatSessionManager (the chat
// endpoints return 503) and stubs WebSocket, so this tier covers the widget
// shell: launching, opening, and the composer. Real WS-streamed replies are
// exercised manually / in Playwright (decision-tree item 5).
//
// The streaming-render tests below can't drive real WS deltas (stubbed), so they
// seed the conversation query cache the hook reads from — `useChat` resolves
// `useQueryClient()` to this same singleton (re-wrapped by __root.tsx) — to put a
// message into each streaming state and assert how the bubble renders it.

const now = () => new Date().toISOString();

function seedConversation(messages: ChatMessage[], compactedCount = 0) {
	queryClient.setQueryData(queryKeys.chatConversation(), {
		conversation_id: 'test-convo',
		messages,
		compacted_count: compactedCount,
	});
}

test('the header CEO monogram opens the dock and composer', async () => {
	const { findByTestId, getByTestId, queryByTestId } = await renderApp({ initialPath: '/home' });

	// The dock renders nothing while closed - the header monogram is the launcher.
	expect(queryByTestId('chat-panel')).toBeNull();
	const launcher = await findByTestId('app-header-chat');
	launcher.click();

	const panel = await findByTestId('chat-panel');
	expect(panel).toBeTruthy();
	expect(getByTestId('chat-input')).toBeTruthy();
	expect(getByTestId('chat-send')).toBeTruthy();

	// The monogram toggles: clicking it again closes the dock.
	launcher.click();
	await waitFor(() => expect(queryByTestId('chat-panel')).toBeNull());
});

test('composer enables send when text is entered and clears on submit', async () => {
	const { findByTestId, getByTestId, user } = await renderApp({ initialPath: '/home' });

	(await findByTestId('app-header-chat')).click();
	const input = (await findByTestId('chat-input')) as HTMLTextAreaElement;
	const send = getByTestId('chat-send') as HTMLButtonElement;

	expect(send.disabled).toBe(true);
	await user.type(input, 'What is blocked?');
	expect(send.disabled).toBe(false);

	await user.click(send);
	// The draft clears immediately on submit regardless of the server result.
	expect(input.value).toBe('');
});

test('shows the user message optimistically and disables send while in flight', async () => {
	const { findByTestId, getByTestId, getByText, queryByText, user } = await renderApp({
		initialPath: '/home',
	});
	(await findByTestId('app-header-chat')).click();
	const input = (await findByTestId('chat-input')) as HTMLTextAreaElement;
	const sendBtn = getByTestId('chat-send') as HTMLButtonElement;

	await user.type(input, 'i just enabled markdown assets');
	// fireEvent (synchronous) so we can observe the optimistic state before the
	// send settles and the real rows take over.
	fireEvent.click(sendBtn);

	// The user's message renders immediately (optimistic), before any WS round-trip…
	expect(getByText('i just enabled markdown assets')).toBeTruthy();
	// …a pending assistant "thinking" indicator shows…
	expect(getByTestId('chat-typing')).toBeTruthy();
	// …and the send button is disabled so an impatient re-click can't spawn duplicates.
	expect(sendBtn.disabled).toBe(true);

	// Once the send settles the message survives as its real stored row (the
	// harness manager persists it and answers with a canned reply). The live
	// re-render rides WS events the component harness stubs, so settle is
	// observed on the store, then a refetch is forced to see the stored row
	// replace the optimistic placeholder.
	await waitFor(async () => {
		const rows = await getTestContext().db.query(
			`SELECT id FROM chat_messages WHERE content = 'i just enabled markdown assets'`,
		);
		expect((rows as { rows: unknown[] }).rows.length).toBe(1);
	});
	await queryClient.invalidateQueries({ queryKey: ['chat'] });
	await waitFor(() => expect(queryByText('i just enabled markdown assets')).toBeTruthy());
});

test('surfaces a failed CEO send as an error toast', async () => {
	// The harness wires a real ChatSessionManager, so force a deterministic
	// failure instead: with no verified provider credential the turn cannot
	// start, POST /api/chat/messages answers 503, and the send mutation's
	// onError must surface the server's message.
	const errorSpy = vi.spyOn(toast, 'error');
	try {
		const { findByTestId, getByTestId, user } = await renderApp({ initialPath: '/home' });
		(await findByTestId('app-header-chat')).click();
		const input = (await findByTestId('chat-input')) as HTMLTextAreaElement;
		// After the tree settled (the SetupGate has already seen a provider), so
		// only the send is affected.
		await getTestContext().db.query('DELETE FROM ai_provider_configs');
		await user.type(input, 'why is everything stuck?');
		await user.click(getByTestId('chat-send') as HTMLButtonElement);
		await waitFor(() =>
			expect(errorSpy).toHaveBeenCalledWith(
				expect.stringContaining('No verified AI provider credential'),
			),
		);
	} finally {
		errorSpy.mockRestore();
	}
});

test('shows the empty state once history loads', async () => {
	const { findByTestId, findByText } = await renderApp({ initialPath: '/home' });
	(await findByTestId('app-header-chat')).click();
	expect(await findByText(/Ask the CEO anything, across every project/i)).toBeTruthy();
});

test('the header identifies the CEO with the HQ badge and the composer invites cross-project questions', async () => {
	const { findByTestId, getByTestId } = await renderApp({ initialPath: '/home' });
	(await findByTestId('app-header-chat')).click();
	const panel = await findByTestId('chat-panel');

	// Header reads "CEO" alongside the HQ team badge (the CEO lives in HQ). Scope
	// to the room title / the panel: the switcher's pinned option also says
	// "CEO · HQ", so a document-wide text query is ambiguous.
	expect(within(panel).getByTestId('chat-room-title').textContent).toBe('CEO');
	expect(within(panel).getByText('HQ')).toBeTruthy();
	// The placeholder reflects the global, every-project scope of the chat.
	const input = getByTestId('chat-input') as HTMLTextAreaElement;
	expect(input.placeholder).toBe('Ask the CEO anything, across every project…');
});

test('keeps the composer open when an HQ pool member has failed', async () => {
	// No pinned CEO container any more: a turn claims any pool container when it
	// is sent, so a failed member is no reason to gate the composer - the turn
	// either finds another container or reports its refusal as a system row in
	// the thread.
	const { findByTestId } = await renderApp({
		initialPath: '/home',
		seed: async (ctx) => {
			await ctx.db.query(
				`INSERT INTO container_pool_members (project_id, container_id, state, last_error)
				 SELECT id, 'failed-hq', 'error'::container_pool_state, 'pull access denied'
				   FROM projects WHERE is_internal = true`,
			);
		},
	});

	(await findByTestId('app-header-chat')).click();
	const panel = await findByTestId('chat-panel');

	await waitFor(() => {
		if (!panel.querySelector('[data-testid="chat-input"]')) throw new Error('composer not ready');
	});
	expect(panel.querySelector('[data-testid="hq-container-notice"]')).toBeNull();
});

test('each message carries its role eyebrow — "You" for the operator, "CEO · HQ" for the CEO', async () => {
	const { findByTestId, findByText } = await renderApp({ initialPath: '/home' });
	(await findByTestId('app-header-chat')).click();
	await findByTestId('chat-panel');

	seedConversation([
		{
			id: 'u1',
			role: 'user',
			channel: 'web',
			status: 'complete',
			content: 'Hi',
			created_at: now(),
		},
		{
			id: 'a1',
			role: 'assistant',
			channel: 'web',
			status: 'complete',
			content: 'Hello',
			created_at: now(),
		},
	]);

	expect(await findByText('You')).toBeTruthy();
	// Scope to the thread: the switcher's pinned option also reads "CEO · HQ".
	const messagesEl = await findByTestId('chat-messages');
	await waitFor(() => expect(within(messagesEl).getByText('CEO · HQ')).toBeTruthy());
});

test('shows the "chat compacted" marker at the top once older messages are compacted', async () => {
	const { findByTestId } = await renderApp({ initialPath: '/home' });
	(await findByTestId('app-header-chat')).click();
	await findByTestId('chat-panel');

	// The retained tail plus a positive compacted_count (older messages summarized
	// into long-term memory and evicted).
	seedConversation(
		[
			{
				id: 'a1',
				role: 'assistant',
				channel: 'web',
				status: 'complete',
				content: 'latest',
				created_at: now(),
			},
		],
		4,
	);

	const banner = await findByTestId('chat-compacted-banner');
	expect(banner.textContent ?? '').toContain('compacted');
});

test('shows no compaction marker when nothing has been compacted', async () => {
	const { findByTestId, findByText, queryByTestId } = await renderApp({ initialPath: '/home' });
	(await findByTestId('app-header-chat')).click();
	await findByTestId('chat-panel');

	seedConversation([
		{
			id: 'a1',
			role: 'assistant',
			channel: 'web',
			status: 'complete',
			content: 'hello there',
			created_at: now(),
		},
	]);

	await findByText('hello there');
	expect(queryByTestId('chat-compacted-banner')).toBeNull();
});

test('the header monogram names its purpose for hover and assistive tech', async () => {
	const { findByTestId } = await renderApp({ initialPath: '/home' });
	const launcher = await findByTestId('app-header-chat');
	expect(launcher.getAttribute('title')).toBe('Chat with the CEO');
	expect(launcher.getAttribute('aria-label')).toBe('Chat with the CEO');
});

test('streaming with no text yet shows the typing indicator, not an empty bubble', async () => {
	const { findByTestId, queryByTestId } = await renderApp({ initialPath: '/home' });
	(await findByTestId('app-header-chat')).click();
	await findByTestId('chat-panel');

	seedConversation([
		{
			id: 'a1',
			role: 'assistant',
			channel: 'web',
			status: 'streaming',
			content: '',
			created_at: now(),
		},
	]);

	expect(await findByTestId('chat-typing')).toBeTruthy();
	// No bubble (the indicator replaces it) and no in-bubble dots yet.
	expect(queryByTestId('chat-message')).toBeNull();
	expect(queryByTestId('chat-streaming-dots')).toBeNull();
});

test('streaming with text shows the reply plus trailing dots, not the standalone indicator', async () => {
	const { findByTestId, findByText, getByTestId, queryByTestId } = await renderApp({
		initialPath: '/home',
	});
	(await findByTestId('app-header-chat')).click();
	await findByTestId('chat-panel');

	seedConversation([
		{
			id: 'a1',
			role: 'assistant',
			channel: 'web',
			status: 'streaming',
			content: 'Working on it',
			created_at: now(),
		},
	]);

	expect(await findByText('Working on it')).toBeTruthy();
	// Dots sit just below the reply bubble; the standalone "thinking"
	// indicator is gone now that the answer has started.
	expect(await findByTestId('chat-streaming-dots')).toBeTruthy();
	expect(getByTestId('chat-message')).toBeTruthy();
	expect(queryByTestId('chat-typing')).toBeNull();
});

test('a completed reply shows no typing dots', async () => {
	const { findByTestId, findByText, queryByTestId } = await renderApp({ initialPath: '/home' });
	(await findByTestId('app-header-chat')).click();
	await findByTestId('chat-panel');

	seedConversation([
		{
			id: 'a1',
			role: 'assistant',
			channel: 'web',
			status: 'complete',
			content: 'All done',
			created_at: now(),
		},
	]);

	expect(await findByText('All done')).toBeTruthy();
	expect(queryByTestId('chat-streaming-dots')).toBeNull();
	expect(queryByTestId('chat-typing')).toBeNull();
});

// The header mirrors the in-thread "still working" dots up next to the CEO
// label, so the processing signal stays visible even when the latest reply has
// scrolled out of view. It tracks the same streaming state as the in-thread
// indicators, whether or not any text has landed yet.
test('the header shows processing dots while the CEO is composing with no text yet', async () => {
	const { findByTestId } = await renderApp({ initialPath: '/home' });
	(await findByTestId('app-header-chat')).click();
	await findByTestId('chat-panel');

	seedConversation([
		{
			id: 'a1',
			role: 'assistant',
			channel: 'web',
			status: 'streaming',
			content: '',
			created_at: now(),
		},
	]);

	expect(await findByTestId('chat-header-dots')).toBeTruthy();
});

test('the header keeps the processing dots while a reply is still streaming text', async () => {
	const { findByTestId, findByText } = await renderApp({ initialPath: '/home' });
	(await findByTestId('app-header-chat')).click();
	await findByTestId('chat-panel');

	seedConversation([
		{
			id: 'a1',
			role: 'assistant',
			channel: 'web',
			status: 'streaming',
			content: 'Working on it',
			created_at: now(),
		},
	]);

	// Both the in-thread trailing dots and the header dots are present mid-stream.
	expect(await findByText('Working on it')).toBeTruthy();
	expect(await findByTestId('chat-header-dots')).toBeTruthy();
});

test('the header drops the processing dots once the reply settles', async () => {
	const { findByTestId, findByText, queryByTestId } = await renderApp({ initialPath: '/home' });
	(await findByTestId('app-header-chat')).click();
	await findByTestId('chat-panel');

	seedConversation([
		{
			id: 'a1',
			role: 'assistant',
			channel: 'web',
			status: 'complete',
			content: 'All done',
			created_at: now(),
		},
	]);

	await findByText('All done');
	expect(queryByTestId('chat-header-dots')).toBeNull();
});

test('a CEO reply renders its markdown as formatted HTML, not raw text', async () => {
	const { findByTestId } = await renderApp({ initialPath: '/home' });
	(await findByTestId('app-header-chat')).click();
	await findByTestId('chat-panel');

	seedConversation([
		{
			id: 'a1',
			role: 'assistant',
			channel: 'web',
			status: 'complete',
			content: ['**Two projects** are live:', '', '- `HQ` — internal', '- `todo6` — todo app'].join(
				'\n',
			),
			created_at: now(),
		},
	]);

	const body = await findByTestId('chat-markdown');
	// Inline emphasis and code spans become real elements rather than literal
	// `**`/backtick syntax.
	expect(body.querySelector('strong')?.textContent).toBe('Two projects');
	const codeText = Array.from(body.querySelectorAll('code')).map((el) => el.textContent);
	expect(codeText).toContain('HQ');
	expect(codeText).toContain('todo6');
	// The dash bullets collapse into a real list.
	expect(body.querySelectorAll('li').length).toBe(2);
	// The raw markdown markers are gone from the visible text.
	expect(body.textContent ?? '').not.toContain('**');
});

// The CEO unread badge is client-tracked in localStorage (the CEO stream has
// no server read state) and the WS-driven increment can't run here (sockets are
// stubbed), so these drive the persisted path: a seeded count renders the
// overlay on the header monogram, and opening the dock clears both the badge
// and the stored tally.
test('the header monogram shows an unread overlay for unseen CEO replies', async () => {
	localStorage.setItem('hezo_chat_unread', '3');
	const { findByTestId } = await renderApp({ initialPath: '/home' });

	const badge = await findByTestId('app-header-chat-badge');
	expect(badge.textContent).toBe('3');
});

test('opening the chat clears the unread overlay and its persisted count', async () => {
	localStorage.setItem('hezo_chat_unread', '2');
	const { findByTestId, queryByTestId } = await renderApp({ initialPath: '/home' });

	// Visible while the dock is closed…
	expect(await findByTestId('app-header-chat-badge')).toBeTruthy();

	// …open (reads it) then close again.
	(await findByTestId('app-header-chat')).click();
	await findByTestId('chat-panel');
	(await findByTestId('chat-close')).click();

	// Back closed, the badge is gone and the stored tally is wiped.
	await waitFor(() => expect(queryByTestId('app-header-chat-badge')).toBeNull());
	expect(localStorage.getItem('hezo_chat_unread')).toBeNull();
});

test('the dock is an anchored corner panel with a mobile-only scrim', async () => {
	const { findByTestId } = await renderApp({ initialPath: '/home' });
	(await findByTestId('app-header-chat')).click();
	const panel = await findByTestId('chat-panel');

	// Anchored desktop panel, clear of the 48px header; near-full-screen below md.
	expect(panel.className).toContain('md:w-[420px]');
	expect(panel.className).toContain('top-16');
	// The scrim is scoped to mobile (`md:hidden`) - the desktop corner panel is a
	// persistent companion that leaves the rest of the page interactive. There is
	// no expand mode: the dock is the whole desktop chat surface.
	const overlay = await findByTestId('chat-overlay');
	expect(overlay.className).toContain('md:hidden');
});

test('Escape closes the dock', async () => {
	const { findByTestId, queryByTestId, user } = await renderApp({
		initialPath: '/home',
	});

	(await findByTestId('app-header-chat')).click();
	await findByTestId('chat-panel');
	await user.keyboard('{Escape}');
	await waitFor(() => expect(queryByTestId('chat-panel')).toBeNull());
	expect(queryByTestId('chat-overlay')).toBeNull();
});

test('a user message is shown as typed, not parsed as markdown', async () => {
	const { findByTestId, findByText } = await renderApp({ initialPath: '/home' });
	(await findByTestId('app-header-chat')).click();
	await findByTestId('chat-panel');

	seedConversation([
		{
			id: 'u1',
			role: 'user',
			channel: 'web',
			status: 'complete',
			content: 'Does **HQ** use `client side storage`?',
			created_at: now(),
		},
	]);

	const bubble = await findByText(/Does \*\*HQ\*\* use `client side storage`\?/);
	// The user's own input is echoed verbatim — no <strong>/<code> transformation.
	expect(bubble.querySelector('strong')).toBeNull();
	expect(bubble.querySelector('code')).toBeNull();
});

test('the copy button writes the whole conversation to the clipboard, labelled by speaker', async () => {
	const { findByTestId, user } = await renderApp({ initialPath: '/home' });
	(await findByTestId('app-header-chat')).click();
	await findByTestId('chat-panel');

	seedConversation([
		{
			id: 'u1',
			role: 'user',
			channel: 'web',
			status: 'complete',
			content: 'What is blocked?',
			created_at: now(),
		},
		{
			id: 'a1',
			role: 'assistant',
			channel: 'web',
			status: 'complete',
			content: 'Nothing is blocked right now.',
			created_at: now(),
		},
	]);

	const copyBtn = (await findByTestId('chat-copy')) as HTMLButtonElement;
	expect(copyBtn.getAttribute('aria-label')).toBe('Copy conversation');

	const writes: string[] = [];
	const originalDesc = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
	Object.defineProperty(navigator, 'clipboard', {
		configurable: true,
		value: {
			writeText: async (t: string) => {
				writes.push(t);
			},
		},
	});
	try {
		await user.click(copyBtn);
		// Each turn is prefixed with its speaker and separated by a blank line.
		expect(writes).toEqual(['You: What is blocked?\n\nCEO · HQ: Nothing is blocked right now.']);
		// The icon swaps to a check — the aria-label flips to "Conversation copied".
		await waitFor(() => expect(copyBtn.getAttribute('aria-label')).toBe('Conversation copied'));
	} finally {
		if (originalDesc) Object.defineProperty(navigator, 'clipboard', originalDesc);
		else delete (navigator as { clipboard?: unknown }).clipboard;
	}
});

test('the copy button is disabled until the conversation has a message', async () => {
	const { findByTestId, getByTestId } = await renderApp({ initialPath: '/home' });
	(await findByTestId('app-header-chat')).click();
	await findByTestId('chat-panel');

	// Empty conversation → nothing to copy yet.
	expect(((await findByTestId('chat-copy')) as HTMLButtonElement).disabled).toBe(true);

	// Once a message lands, the affordance enables.
	seedConversation([
		{
			id: 'u1',
			role: 'user',
			channel: 'web',
			status: 'complete',
			content: 'Hi',
			created_at: now(),
		},
	]);
	await waitFor(() => expect((getByTestId('chat-copy') as HTMLButtonElement).disabled).toBe(false));
});

test('each message has its own copy button that copies only that message', async () => {
	const { findByTestId, findAllByTestId, user } = await renderApp({ initialPath: '/home' });
	(await findByTestId('app-header-chat')).click();
	await findByTestId('chat-panel');

	seedConversation([
		{
			id: 'u1',
			role: 'user',
			channel: 'web',
			status: 'complete',
			content: 'First, the question',
			created_at: now(),
		},
		{
			id: 'a1',
			role: 'assistant',
			channel: 'web',
			status: 'complete',
			content: 'Then, the answer',
			created_at: now(),
		},
	]);

	// One copy affordance per message — for the operator's turn and the CEO's alike.
	const copyButtons = await findAllByTestId('chat-message-copy');
	expect(copyButtons).toHaveLength(2);
	expect(copyButtons[0].getAttribute('aria-label')).toBe('Copy message');

	const writes: string[] = [];
	const originalDesc = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
	Object.defineProperty(navigator, 'clipboard', {
		configurable: true,
		value: {
			writeText: async (t: string) => {
				writes.push(t);
			},
		},
	});
	try {
		// Copying the CEO reply writes only that message's text — no speaker label
		// and none of the other turns.
		await user.click(copyButtons[1]);
		expect(writes).toEqual(['Then, the answer']);
		// The check confirms on the button that was clicked…
		await waitFor(() => expect(copyButtons[1].getAttribute('aria-label')).toBe('Message copied'));
		// …and only that one — the sibling stays idle.
		expect(copyButtons[0].getAttribute('aria-label')).toBe('Copy message');
	} finally {
		if (originalDesc) Object.defineProperty(navigator, 'clipboard', originalDesc);
		else delete (navigator as { clipboard?: unknown }).clipboard;
	}
});

test('a streaming reply shows no per-message copy button until it settles', async () => {
	const { findByTestId, findByText, queryAllByTestId } = await renderApp({ initialPath: '/home' });
	(await findByTestId('app-header-chat')).click();
	await findByTestId('chat-panel');

	seedConversation([
		{
			id: 'a1',
			role: 'assistant',
			channel: 'web',
			status: 'streaming',
			content: 'Working on it',
			created_at: now(),
		},
	]);

	await findByText('Working on it');
	// Mid-stream the trailing dots stand in; the copy affordance only appears once
	// the reply is complete.
	expect(queryAllByTestId('chat-message-copy')).toHaveLength(0);
});

test('a handoff warning renders as its own meta row, wrapping rather than as a bubble', async () => {
	const { findByTestId, findByText, queryByTestId } = await renderApp({ initialPath: '/home' });
	(await findByTestId('app-header-chat')).click();
	await findByTestId('chat-panel');

	const warning =
		'This chat turn woke no one on TO-3. It named **captain** there without an active ' +
		'@-mention and left TO-3 open, so whoever acts next was never notified.';
	seedConversation([
		{
			id: 'a1',
			role: 'assistant',
			channel: 'web',
			status: 'complete',
			content: 'Posted an update.',
			created_at: now(),
		},
		{
			id: 's1',
			role: 'system',
			channel: 'web',
			status: 'complete',
			content: warning,
			created_at: now(),
			system_kind: 'handoff_not_delivered',
		},
	]);

	// The whole sentence is present: naming the task and the teammate is the point
	// of the warning, so unlike the converted marker this row must not truncate.
	expect(await findByText(warning)).toBeTruthy();
	const row = document.querySelector('[data-system-kind="handoff_not_delivered"]');
	expect(row).toBeTruthy();
	expect(row?.getAttribute('data-role')).toBe('system');
	// Never mistaken for the CEO speaking.
	expect(queryByTestId('chat-converted-task-link')).toBeNull();
});

test('a connector refusal renders as the same warning row, keyed by its own kind', async () => {
	const { findByTestId, findByText, queryByTestId } = await renderApp({ initialPath: '/home' });
	(await findByTestId('app-header-chat')).click();
	await findByTestId('chat-panel');

	const warning =
		'connector "ibkr" refused this run\'s request (HTTP 401) although its credential was sent. ' +
		'Hezo is re-checking it.';
	seedConversation([
		{
			id: 'a1',
			role: 'assistant',
			channel: 'web',
			status: 'complete',
			content: 'Checking the portfolio.',
			created_at: now(),
		},
		{
			id: 's1',
			role: 'system',
			channel: 'web',
			status: 'complete',
			content: warning,
			created_at: now(),
			system_kind: 'connector_refused',
		},
	]);

	expect(await findByText(warning)).toBeTruthy();
	const row = document.querySelector('[data-system-kind="connector_refused"]');
	expect(row).toBeTruthy();
	expect(row?.getAttribute('data-role')).toBe('system');
	expect(queryByTestId('chat-converted-task-link')).toBeNull();
});

test('a credential wait renders as a quiet notice with the holding run linked', async () => {
	const { findByTestId, queryByTestId } = await renderApp({ initialPath: '/home' });
	(await findByTestId('app-header-chat')).click();
	await findByTestId('chat-panel');

	seedConversation([
		{
			id: 's1',
			role: 'system',
			channel: 'web',
			status: 'complete',
			content:
				'Waiting for [growth-analyst/HM-336](/projects/hezo-marketing/agents/growth-analyst/executions/run-hm-336) to finish with this credential.',
			created_at: now(),
			system_kind: 'credential_wait',
		},
		{
			id: 'a1',
			role: 'assistant',
			channel: 'web',
			status: 'streaming',
			content: '',
			created_at: now(),
		},
	]);

	const row = await vi.waitFor(() => {
		const el = document.querySelector('[data-system-kind="credential_wait"]');
		if (!el) throw new Error('no row yet');
		return el;
	});
	expect(row.getAttribute('data-role')).toBe('system');
	// The sentence reads as written, with the holder's name as the link.
	expect(row.textContent).toBe('Waiting for growth-analyst/HM-336 to finish with this credential.');
	const link = row.querySelector('[data-testid="run-link"]') as HTMLAnchorElement | null;
	expect(link?.getAttribute('href')).toBe(
		'/projects/hezo-marketing/agents/growth-analyst/executions/run-hm-336',
	);
	expect(link?.textContent).toBe('growth-analyst/HM-336');
	// A notice, not a warning: no amber.
	expect(row.className).not.toContain('bg-warning-soft');
	expect(queryByTestId('chat-converted-task-link')).toBeNull();
});

test('a failed reply shows the reason the server recorded, not a generic message', async () => {
	const { findByTestId } = await renderApp({ initialPath: '/home' });
	(await findByTestId('app-header-chat')).click();
	await findByTestId('chat-panel');

	seedConversation([
		{
			id: 'a1',
			role: 'assistant',
			channel: 'web',
			status: 'failed',
			content: '',
			created_at: now(),
			error:
				'[growth-analyst/HM-336](/projects/hezo-marketing/agents/growth-analyst/executions/run-hm-336) is still using this provider credential; this subscription runs one agent at a time.',
		},
		{
			id: 'a2',
			role: 'assistant',
			channel: 'web',
			status: 'failed',
			content: '',
			created_at: now(),
		},
	]);

	const failures = await vi.waitFor(() => {
		const els = document.querySelectorAll('[data-testid="chat-failure"]');
		if (els.length !== 2) throw new Error('not rendered yet');
		return els;
	});
	expect(failures[0].textContent).toBe(
		'growth-analyst/HM-336 is still using this provider credential; this subscription runs one agent at a time.',
	);
	expect(failures[0].querySelector('[data-testid="run-link"]')?.getAttribute('href')).toBe(
		'/projects/hezo-marketing/agents/growth-analyst/executions/run-hm-336',
	);
	// With no recorded reason the bare fact still shows.
	expect(failures[1].textContent).toBe('Something went wrong.');
});
