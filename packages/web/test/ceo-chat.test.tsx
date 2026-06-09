import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';

// The component harness builds the backend without a CeoSessionManager (the chat
// endpoints return 503) and stubs WebSocket, so this tier covers the widget
// shell: launching, opening, and the composer. Real WS-streamed replies are
// exercised manually / in Playwright (decision-tree item 5).

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
