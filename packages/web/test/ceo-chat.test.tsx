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

test('blocks the composer and links to the container page when the HQ container is down', async () => {
	const { findByTestId } = await renderApp({
		initialPath: '/home',
		seed: async (ctx) => {
			await ctx.db.query(
				`UPDATE projects SET container_status = 'error',
				        container_error = 'pull access denied'
				 WHERE is_internal = true`,
			);
		},
	});

	(await findByTestId('ceo-chat-launcher')).click();
	const panel = await findByTestId('ceo-chat-panel');

	// The container-state notice replaces the composer inside the chat panel.
	const notice = await waitFor(() => {
		const el = panel.querySelector('[data-testid="hq-container-notice"]');
		if (!el) throw new Error('notice not yet rendered');
		return el as HTMLElement;
	});
	expect(notice.textContent ?? '').toContain('error');
	expect(panel.querySelector('[data-testid="ceo-chat-input"]')).toBeNull();

	// It links to the HQ container page.
	const link = notice.querySelector('[data-testid="hq-container-notice-link"]');
	expect(link?.getAttribute('href')).toContain('/projects/hq/container');
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

test('expanded mode lays a modal backdrop that dismisses the chat when clicked', async () => {
	const { findByTestId, queryByTestId, getByTestId } = await renderApp({ initialPath: '/home' });
	(await findByTestId('ceo-chat-launcher')).click();
	await findByTestId('ceo-chat-panel');

	// Anchored: no backdrop — the rest of the page stays interactive.
	expect(queryByTestId('ceo-chat-overlay')).toBeNull();

	// Expanding makes it modal: a scrim appears behind the panel.
	getByTestId('ceo-chat-expand').click();
	const overlay = await findByTestId('ceo-chat-overlay');
	expect(overlay).toBeTruthy();

	// Clicking the backdrop dismisses the chat entirely.
	overlay.click();
	await findByTestId('ceo-chat-launcher');
	expect(queryByTestId('ceo-chat-panel')).toBeNull();
	expect(queryByTestId('ceo-chat-overlay')).toBeNull();
});

test('collapsing out of expanded removes the backdrop but keeps the chat open', async () => {
	const { findByTestId, queryByTestId, getByTestId } = await renderApp({ initialPath: '/home' });
	(await findByTestId('ceo-chat-launcher')).click();
	await findByTestId('ceo-chat-panel');

	getByTestId('ceo-chat-expand').click();
	await findByTestId('ceo-chat-overlay');

	// The collapse toggle exits modal mode: backdrop gone, panel still open.
	getByTestId('ceo-chat-expand').click();
	await waitFor(() => expect(queryByTestId('ceo-chat-overlay')).toBeNull());
	expect(getByTestId('ceo-chat-panel')).toBeTruthy();
});

test('Escape closes the chat from both the anchored and the expanded view', async () => {
	const { findByTestId, queryByTestId, user } = await renderApp({
		initialPath: '/home',
	});

	// Anchored → Escape closes back to the launcher.
	(await findByTestId('ceo-chat-launcher')).click();
	await findByTestId('ceo-chat-panel');
	await user.keyboard('{Escape}');
	await findByTestId('ceo-chat-launcher');
	expect(queryByTestId('ceo-chat-panel')).toBeNull();

	// Expanded (modal) → Escape closes it too, scrim and all.
	(await findByTestId('ceo-chat-launcher')).click();
	(await findByTestId('ceo-chat-expand')).click();
	await findByTestId('ceo-chat-overlay');
	await user.keyboard('{Escape}');
	await findByTestId('ceo-chat-launcher');
	expect(queryByTestId('ceo-chat-panel')).toBeNull();
	expect(queryByTestId('ceo-chat-overlay')).toBeNull();
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

test('the copy button writes the whole conversation to the clipboard, labelled by speaker', async () => {
	const { findByTestId, user } = await renderApp({ initialPath: '/home' });
	(await findByTestId('ceo-chat-launcher')).click();
	await findByTestId('ceo-chat-panel');

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

	const copyBtn = (await findByTestId('ceo-chat-copy')) as HTMLButtonElement;
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
	(await findByTestId('ceo-chat-launcher')).click();
	await findByTestId('ceo-chat-panel');

	// Empty conversation → nothing to copy yet.
	expect(((await findByTestId('ceo-chat-copy')) as HTMLButtonElement).disabled).toBe(true);

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
	await waitFor(() =>
		expect((getByTestId('ceo-chat-copy') as HTMLButtonElement).disabled).toBe(false),
	);
});

test('each message has its own copy button that copies only that message', async () => {
	const { findByTestId, findAllByTestId, user } = await renderApp({ initialPath: '/home' });
	(await findByTestId('ceo-chat-launcher')).click();
	await findByTestId('ceo-chat-panel');

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
	const copyButtons = await findAllByTestId('ceo-chat-message-copy');
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

	await findByText('Working on it');
	// Mid-stream the trailing dots stand in; the copy affordance only appears once
	// the reply is complete.
	expect(queryAllByTestId('ceo-chat-message-copy')).toHaveLength(0);
});
