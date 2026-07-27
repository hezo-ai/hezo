import type { ChatMessage } from '@hezo/web/hooks/use-chat';
import { LONG_PRESS_MS } from '@hezo/web/hooks/use-long-press';
import { queryClient } from '@hezo/web/lib/query-client';
import { queryKeys } from '@hezo/web/lib/query-keys';
import { fireEvent, waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';

// Queue-and-interrupt in the CEO chatbox. The harness builds the backend without a
// ChatSessionManager (chat endpoints 503) and stubs WebSocket, so these seed the
// conversation cache `useChat` reads from to put the thread into a streaming state,
// then drive the composer. Everything asserted here is DOM + local queue state, so
// it belongs in the component tier rather than Playwright.

const now = () => new Date().toISOString();

/** Put the thread into "CEO is mid-reply" — a streaming assistant row with text. */
function seedStreaming() {
	const messages: ChatMessage[] = [
		{
			id: 'u1',
			role: 'user',
			channel: 'web',
			status: 'complete',
			content: 'what is blocking the release?',
			created_at: now(),
		},
		{
			id: 'a1',
			role: 'assistant',
			channel: 'web',
			status: 'streaming',
			content: 'Two things. QA is holding on',
			created_at: now(),
		},
	];
	queryClient.setQueryData(queryKeys.chatConversation(), {
		conversation_id: 'test-convo',
		messages,
		compacted_count: 0,
	});
}

/** Settle the streamed reply so the thread goes idle and the queue flushes. */
function settleReply() {
	queryClient.setQueryData(queryKeys.chatConversation(), {
		conversation_id: 'test-convo',
		messages: [
			{
				id: 'u1',
				role: 'user',
				channel: 'web',
				status: 'complete',
				content: 'what is blocking the release?',
				created_at: now(),
			},
			{
				id: 'a1',
				role: 'assistant',
				channel: 'web',
				status: 'complete',
				content: 'Two things. QA is holding on the migration test.',
				created_at: now(),
			},
		] satisfies ChatMessage[],
		compacted_count: 0,
	});
}

async function openChatMidReply() {
	const app = await renderApp({ initialPath: '/home' });
	(await app.findByTestId('chat-launcher')).click();
	await app.findByTestId('chat-input');
	seedStreaming();
	await app.findByTestId('chat-header-dots');
	return app;
}

test('the composer stays usable while the CEO is replying', async () => {
	const { findByTestId, getByTestId, user } = await openChatMidReply();

	const input = (await findByTestId('chat-input')) as HTMLTextAreaElement;
	const send = getByTestId('chat-send') as HTMLButtonElement;

	// Previously both were locked for the whole reply.
	expect(input.disabled).toBe(false);
	await user.type(input, 'also check the Coach backlog');
	expect(send.disabled).toBe(false);
	// The button says what pressing it does, rather than sending.
	expect(send.dataset.mode).toBe('queue');
	expect(send.textContent).toContain('Queue');
});

test('Enter queues while streaming, and the queued message can be removed again', async () => {
	const { findByTestId, getByTestId, queryByTestId, findByText, queryByText, user } =
		await openChatMidReply();

	const input = (await findByTestId('chat-input')) as HTMLTextAreaElement;
	await user.type(input, 'also check the Coach backlog{Enter}');

	// It parks as a queued bubble rather than posting…
	await findByText('also check the Coach backlog');
	expect(getByTestId('chat-queued-message')).toBeTruthy();
	// …the header count reflects it, and the composer is clear for the next one.
	expect(getByTestId('chat-queue-count').textContent).toContain('1 queued');
	expect(input.value).toBe('');

	await user.type(input, 'and who owns the 041 test?{Enter}');
	await waitFor(() => expect(getByTestId('chat-queue-count').textContent).toContain('2 queued'));

	// Removing one drops it entirely — nothing was ever sent.
	const removes = document.querySelectorAll('[data-testid="chat-queue-remove"]');
	expect(removes.length).toBe(2);
	await user.click(removes[0] as HTMLElement);
	await waitFor(() => expect(queryByText('also check the Coach backlog')).toBeNull());
	expect(getByTestId('chat-queue-count').textContent).toContain('1 queued');

	// Removing the last one takes the whole queue affordance away.
	await user.click(document.querySelector('[data-testid="chat-queue-remove"]') as HTMLElement);
	await waitFor(() => expect(queryByTestId('chat-queue')).toBeNull());
	expect(queryByTestId('chat-queue-count')).toBeNull();
});

test('the queue flushes as one send when the reply settles', async () => {
	const { findByTestId, getByTestId, queryByTestId, user } = await openChatMidReply();

	const input = (await findByTestId('chat-input')) as HTMLTextAreaElement;
	await user.type(input, 'first queued{Enter}');
	await user.type(input, 'second queued{Enter}');
	expect(getByTestId('chat-queue-count').textContent).toContain('2 queued');

	// Record what actually goes over the wire: the claim is ONE request carrying
	// both messages in order, not two requests (which would be two CEO replies).
	const sends: unknown[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input.toString();
		if (url.includes('/api/chat/messages') && init?.method === 'POST') {
			sends.push(JSON.parse(String(init.body)));
		}
		return realFetch(input, init);
	}) as typeof fetch;

	try {
		settleReply();
		await waitFor(() => expect(queryByTestId('chat-queue')).toBeNull());
		await waitFor(() => expect(sends).toHaveLength(1));
		expect(sends[0]).toMatchObject({
			messages: [
				{ text: 'first queued', attachment_ids: [] },
				{ text: 'second queued', attachment_ids: [] },
			],
		});
	} finally {
		globalThis.fetch = realFetch;
	}
});

test('Cmd+Enter sends immediately instead of queueing', async () => {
	const { findByTestId, queryByTestId, user } = await openChatMidReply();

	const input = (await findByTestId('chat-input')) as HTMLTextAreaElement;
	await user.type(input, 'stop, do this instead');
	fireEvent.keyDown(input, { key: 'Enter', metaKey: true });

	// Nothing parks — it goes out as its own turn, which the server turns into an
	// interrupt of the in-flight reply.
	expect(queryByTestId('chat-queue')).toBeNull();
	expect(input.value).toBe('');
});

test('holding the button arms Send now, and dragging off aborts the hold', async () => {
	const { findByTestId, getByTestId, queryByTestId, user } = await openChatMidReply();

	const input = (await findByTestId('chat-input')) as HTMLTextAreaElement;
	await user.type(input, 'stop, do this instead');
	const send = getByTestId('chat-send') as HTMLButtonElement;
	expect(send.dataset.mode).toBe('queue');

	// Hold past the threshold: the button flips to the interrupt.
	fireEvent.pointerDown(send, { button: 0 });
	await waitFor(() => expect(send.dataset.mode).toBe('send-now'), {
		timeout: LONG_PRESS_MS + 500,
	});
	expect(send.textContent).toContain('Send now');

	// Dragging off before release aborts: nothing sent, nothing queued, draft kept.
	fireEvent.pointerLeave(send);
	await waitFor(() => expect(send.dataset.mode).toBe('queue'));
	expect(queryByTestId('chat-queue')).toBeNull();
	expect(input.value).toBe('stop, do this instead');
});

test('a quick tap on the held button queues rather than interrupting', async () => {
	const { findByTestId, getByTestId, user } = await openChatMidReply();

	const input = (await findByTestId('chat-input')) as HTMLTextAreaElement;
	await user.type(input, 'can wait');
	const send = getByTestId('chat-send') as HTMLButtonElement;

	// Down and straight back up — well inside the threshold.
	fireEvent.pointerDown(send, { button: 0 });
	fireEvent.pointerUp(send, { button: 0 });

	await waitFor(() => expect(getByTestId('chat-queued-message').textContent).toContain('can wait'));
});

test('with nothing streaming the button is a plain send and never arms', async () => {
	const { findByTestId, getByTestId, user } = await renderApp({ initialPath: '/home' });
	(await findByTestId('chat-launcher')).click();

	const input = (await findByTestId('chat-input')) as HTMLTextAreaElement;
	await user.type(input, 'hello');
	const send = getByTestId('chat-send') as HTMLButtonElement;
	expect(send.dataset.mode).toBe('send');

	// There is no reply to interrupt, so holding must not offer one.
	fireEvent.pointerDown(send, { button: 0 });
	await new Promise((r) => setTimeout(r, LONG_PRESS_MS + 100));
	expect(send.dataset.mode).toBe('send');
});
