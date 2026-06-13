import { CHAT_MEMORY_SLUG, HQ_PROJECT_SLUG } from '@hezo/shared';
import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';

async function putHqDoc(filename: string, content: string): Promise<void> {
	const { apiBase, token } = getTestContext();
	await apiBase(`/api/projects/${HQ_PROJECT_SLUG}/docs/${filename}`, {
		method: 'PUT',
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ content }),
	});
}

test('chatbox settings page shows the history window and saves a new value', async () => {
	const { findByTestId, findByRole, user } = await renderApp({ initialPath: '/settings/chatbox' });

	await findByRole('heading', { name: 'Chatbox' });
	const input = (await findByTestId('chat-history-limit-input')) as HTMLInputElement;
	// Default when unset.
	expect(input.value).toBe('80');

	await user.clear(input);
	await user.type(input, '120');
	await user.click(await findByTestId('chat-history-limit-save'));

	// Response-driven: the input reflects the server-echoed value.
	await waitFor(() => expect(input.value).toBe('120'));

	const { apiBase, token } = getTestContext();
	const res = await apiBase('/api/instance-settings', {
		headers: { Authorization: `Bearer ${token}` },
	});
	expect((await res.json()).data.chat_history_limit).toBe(120);
});

test('chat-memory.md in HQ shows the protected banner and no delete button', async () => {
	const { findByTestId, queryByLabelText } = await renderApp({
		initialPath: `/projects/${HQ_PROJECT_SLUG}/documents?file=${CHAT_MEMORY_SLUG}`,
	});

	// Banner explaining the protected doc renders.
	await findByTestId('chat-memory-banner');
	// Delete affordance is suppressed for this doc.
	expect(queryByLabelText('Delete document')).toBeNull();
});

test('a normal HQ doc shows the delete button and no chat-memory banner', async () => {
	const { findByLabelText, queryByTestId } = await renderApp({
		initialPath: `/projects/${HQ_PROJECT_SLUG}/documents?file=notes.md`,
		seed: async () => {
			await putHqDoc('notes.md', '# Notes');
		},
	});

	// Delete affordance is present for an ordinary doc.
	await findByLabelText('Delete document');
	// No protected-doc banner.
	expect(queryByTestId('chat-memory-banner')).toBeNull();
});
