import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';

test('chatbox settings page shows the window size in KB and saves a new value', async () => {
	const { findByTestId, findByRole, user } = await renderApp({ initialPath: '/settings/chatbox' });

	await findByRole('heading', { name: 'Chatbox' });
	const input = (await findByTestId('chat-history-size-input')) as HTMLInputElement;
	// Default when unset: 40 KB.
	expect(input.value).toBe('40');

	await user.clear(input);
	await user.type(input, '80');
	await user.click(await findByTestId('chat-history-size-save'));

	// Response-driven: the input reflects the server-echoed value (in KB).
	await waitFor(() => expect(input.value).toBe('80'));

	const { apiBase, token } = getTestContext();
	const res = await apiBase('/api/instance-settings', {
		headers: { Authorization: `Bearer ${token}` },
	});
	// Stored as bytes.
	expect((await res.json()).data.max_chat_history_size).toBe(80 * 1024);
});
