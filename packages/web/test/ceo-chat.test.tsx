import type { CeoMessage } from '@hezo/web/hooks/use-ceo-chat';
import { queryClient } from '@hezo/web/lib/query-client';
import { queryKeys } from '@hezo/web/lib/query-keys';
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

test('streaming with text shows the reply plus in-bubble dots, not the standalone indicator', async () => {
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
	// Dots move into the bottom of the reply bubble; the standalone "thinking"
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
