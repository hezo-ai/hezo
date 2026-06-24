import type { CeoMessage } from '@hezo/web/hooks/use-ceo-chat';
import { queryClient } from '@hezo/web/lib/query-client';
import { queryKeys } from '@hezo/web/lib/query-keys';
import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';

// The component harness builds the backend without a CeoSessionManager (the chat
// endpoints return 503) and stubs WebSocket, so this tier covers the widget
// shell: launching, opening, and the composer. Real WS-streamed replies are
// exercised manually / in Playwright (decision-tree item 5).
//
// The streaming-render tests below can't drive real WS deltas (stubbed), so they
// seed the conversation query cache the hook reads from — `useCeoChat` resolves
// `useQueryClient()` to this same singleton (re-wrapped by __root.tsx) — to put a
// message into each streaming state and assert how the bubble renders it.

const now = () => new Date().toISOString();

function seedConversation(messages: CeoMessage[]) {
	queryClient.setQueryData(queryKeys.ceoConversation(), {
		conversation_id: 'test-convo',
		messages,
	});
}

test('CEO chat launcher opens the panel and composer', async () => {
	const { findByTestId, getByTestId } = await renderApp({ initialPath: '/home' });

	const launcher = await findByTestId('ceo-chat-launcher');
	launcher.click();

	const panel = await findByTestId('ceo-chat-panel');
	expect(panel).toBeTruthy();
	expect(getByTestId('ceo-chat-input')).toBeTruthy();
	expect(getByTestId('ceo-chat-send')).toBeTruthy();
});

test('composer enables send when text is entered and clears on submit', async () => {
	const { findByTestId, getByTestId, user } = await renderApp({ initialPath: '/home' });

	(await findByTestId('ceo-chat-launcher')).click();
	const input = (await findByTestId('ceo-chat-input')) as HTMLTextAreaElement;
	const send = getByTestId('ceo-chat-send') as HTMLButtonElement;

	expect(send.disabled).toBe(true);
	await user.type(input, 'What is blocked?');
	expect(send.disabled).toBe(false);

	await user.click(send);
	// The draft clears immediately on submit regardless of the server result.
	expect(input.value).toBe('');
});

test('shows the empty state once history loads', async () => {
	const { findByTestId, findByText } = await renderApp({ initialPath: '/home' });
	(await findByTestId('ceo-chat-launcher')).click();
	expect(await findByText(/Say hello to the CEO/i)).toBeTruthy();
});

test('the header identifies the CEO with the HQ badge and the composer invites cross-project questions', async () => {
	const { findByTestId, getByTestId, getByText } = await renderApp({ initialPath: '/home' });
	(await findByTestId('ceo-chat-launcher')).click();
	await findByTestId('ceo-chat-panel');

	// Header reads "CEO" alongside the HQ team badge (the CEO lives in HQ).
	expect(getByText('CEO')).toBeTruthy();
	expect(getByText('HQ')).toBeTruthy();
	// The placeholder reflects the global, every-project scope of the chat.
	const input = getByTestId('ceo-chat-input') as HTMLTextAreaElement;
	expect(input.placeholder).toBe('Ask the CEO anything, across every project…');
});

test('each message carries its role eyebrow — "You" for the operator, "CEO · HQ" for the CEO', async () => {
	const { findByTestId, findByText } = await renderApp({ initialPath: '/home' });
	(await findByTestId('ceo-chat-launcher')).click();
	await findByTestId('ceo-chat-panel');

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
	expect(await findByText('CEO · HQ')).toBeTruthy();
});

test('the closed launcher button exposes a "Chat with CEO" tooltip on hover', async () => {
	const { findByTestId, getAllByText, user } = await renderApp({ initialPath: '/home' });
	const launcher = await findByTestId('ceo-chat-launcher');
	await user.hover(launcher);
	await waitFor(() => expect(getAllByText('Chat with CEO').length).toBeGreaterThan(0));
});

test('streaming with no text yet shows the typing indicator, not an empty bubble', async () => {
	const { findByTestId, queryByTestId } = await renderApp({ initialPath: '/home' });
	(await findByTestId('ceo-chat-launcher')).click();
	await findByTestId('ceo-chat-panel');

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

	expect(await findByTestId('ceo-chat-typing')).toBeTruthy();
	// No bubble (the indicator replaces it) and no in-bubble dots yet.
	expect(queryByTestId('ceo-chat-message')).toBeNull();
	expect(queryByTestId('ceo-chat-streaming-dots')).toBeNull();
});

test('streaming with text shows the reply plus trailing dots, not the standalone indicator', async () => {
	const { findByTestId, findByText, getByTestId, queryByTestId } = await renderApp({
		initialPath: '/home',
	});
	(await findByTestId('ceo-chat-launcher')).click();
	await findByTestId('ceo-chat-panel');

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
	expect(await findByTestId('ceo-chat-streaming-dots')).toBeTruthy();
	expect(getByTestId('ceo-chat-message')).toBeTruthy();
	expect(queryByTestId('ceo-chat-typing')).toBeNull();
});

test('a completed reply shows no typing dots', async () => {
	const { findByTestId, findByText, queryByTestId } = await renderApp({ initialPath: '/home' });
	(await findByTestId('ceo-chat-launcher')).click();
	await findByTestId('ceo-chat-panel');

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
	expect(queryByTestId('ceo-chat-streaming-dots')).toBeNull();
	expect(queryByTestId('ceo-chat-typing')).toBeNull();
});

test('a CEO reply renders its markdown as formatted HTML, not raw text', async () => {
	const { findByTestId } = await renderApp({ initialPath: '/home' });
	(await findByTestId('ceo-chat-launcher')).click();
	await findByTestId('ceo-chat-panel');

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

	const body = await findByTestId('ceo-chat-markdown');
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

// The unread badge is client-tracked in localStorage (the CEO conversation has
// no server read state) and the WS-driven increment can't run here (sockets are
// stubbed), so these drive the persisted path: a seeded count renders the
// overlay, and opening the chat clears both the badge and the stored tally.
test('the minimized launcher shows an unread overlay for unseen CEO replies', async () => {
	localStorage.setItem('hezo_ceo_unread', '3');
	const { findByTestId } = await renderApp({ initialPath: '/home' });

	const badge = await findByTestId('ceo-chat-unread-badge');
	expect(badge.textContent).toBe('3');
	// The accessible name surfaces the count too, not just the visual dot.
	const launcher = await findByTestId('ceo-chat-launcher');
	expect(launcher.getAttribute('aria-label')).toBe('Chat with the CEO (3 unread)');
});

test('opening the chat clears the unread overlay and its persisted count', async () => {
	localStorage.setItem('hezo_ceo_unread', '2');
	const { findByTestId, queryByTestId } = await renderApp({ initialPath: '/home' });

	// Visible on the closed launcher…
	expect(await findByTestId('ceo-chat-unread-badge')).toBeTruthy();

	// …open (reads it) then close again.
	(await findByTestId('ceo-chat-launcher')).click();
	await findByTestId('ceo-chat-panel');
	(await findByTestId('ceo-chat-close')).click();

	// Back on the launcher the badge is gone and the stored tally is wiped.
	await findByTestId('ceo-chat-launcher');
	await waitFor(() => expect(queryByTestId('ceo-chat-unread-badge')).toBeNull());
	expect(localStorage.getItem('hezo_ceo_unread')).toBeNull();
});

test('the expand toggle fills the viewport below the nav, then restores the anchored panel', async () => {
	const { findByTestId, getByTestId } = await renderApp({ initialPath: '/home' });
	(await findByTestId('ceo-chat-launcher')).click();
	const panel = await findByTestId('ceo-chat-panel');

	// Default: anchored desktop panel, clear of the 48px header (top-16).
	expect(panel.getAttribute('data-expanded')).toBe('false');
	expect(panel.className).toContain('md:w-[420px]');
	expect(panel.className).toContain('top-16');

	const expand = getByTestId('ceo-chat-expand');
	expect(expand.getAttribute('aria-label')).toBe('Expand chat');
	expand.click();

	// Expanded: fills the viewport (no fixed desktop width) but still below the nav.
	await waitFor(() => expect(panel.getAttribute('data-expanded')).toBe('true'));
	expect(panel.className).toContain('md:inset-x-4');
	expect(panel.className).not.toContain('md:w-[420px]');
	expect(panel.className).toContain('top-16');
	expect(getByTestId('ceo-chat-expand').getAttribute('aria-label')).toBe('Collapse chat');

	// Collapse restores the anchored panel.
	getByTestId('ceo-chat-expand').click();
	await waitFor(() => expect(panel.getAttribute('data-expanded')).toBe('false'));
	expect(panel.className).toContain('md:w-[420px]');
});

test('a user message is shown as typed, not parsed as markdown', async () => {
	const { findByTestId, findByText } = await renderApp({ initialPath: '/home' });
	(await findByTestId('ceo-chat-launcher')).click();
	await findByTestId('ceo-chat-panel');

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
