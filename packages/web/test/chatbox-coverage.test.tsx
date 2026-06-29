import { CHAT_HISTORY_LIMIT_MAX, CHAT_HISTORY_LIMIT_MIN, CHAT_MEMORY_SLUG } from '@hezo/shared';
import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';

// Branch: me && !me.is_superuser → the "managed by the Admin" message instead of
// the chatbox settings sections.
test('non-superuser sees the managed message instead of the chatbox settings', async () => {
	const { findByText, queryByTestId } = await renderApp({
		initialPath: '/settings/chatbox',
		seed: async (ctx) => {
			await ctx.db.query('UPDATE users SET is_superuser = false');
		},
	});

	await findByText(/managed by the Admin/i);
	// The history-limit form (superuser-only) never renders.
	expect(queryByTestId('chat-history-limit-input')).toBeNull();
});

// Superuser renders the form + memory document copy referencing the memory slug.
test('superuser sees the history-limit form and the memory document slug', async () => {
	const { findByText, findByTestId } = await renderApp({ initialPath: '/settings/chatbox' });

	await findByText('Chatbox', { selector: 'h1' });
	await findByTestId('chat-history-limit-input');
	await findByText(CHAT_MEMORY_SLUG);
});

// Branch: the Save button is disabled while the input is not dirty (value matches
// the persisted setting), and enables only after the value changes.
test('save button is gated on the dirty branch', async () => {
	const { findByTestId, user } = await renderApp({ initialPath: '/settings/chatbox' });

	const input = (await findByTestId('chat-history-limit-input')) as HTMLInputElement;
	const save = (await findByTestId('chat-history-limit-save')) as HTMLButtonElement;
	// Initial value equals the persisted default → not dirty → disabled.
	await waitFor(() => expect(save.disabled).toBe(true));

	await user.clear(input);
	await user.type(input, String(CHAT_HISTORY_LIMIT_MAX - 1));
	await waitFor(() => expect(save.disabled).toBe(false));
});

// Branch: validation guard — out-of-range / non-numeric value surfaces the inline
// error and does not persist.
test('an out-of-range history limit shows the inline error', async () => {
	const { findByTestId, user } = await renderApp({ initialPath: '/settings/chatbox' });

	const input = (await findByTestId('chat-history-limit-input')) as HTMLInputElement;
	await user.clear(input);
	await user.type(input, String(CHAT_HISTORY_LIMIT_MAX + 100));
	await user.click(await findByTestId('chat-history-limit-save'));

	const error = await findByTestId('chat-history-limit-error');
	expect(error.textContent).toMatch(
		new RegExp(`between ${CHAT_HISTORY_LIMIT_MIN} and ${CHAT_HISTORY_LIMIT_MAX}`),
	);
});

// Branch: a NaN value (blank-after-clear / non-numeric) also trips the guard.
test('a non-numeric history limit shows the inline error', async () => {
	const { findByTestId, user } = await renderApp({ initialPath: '/settings/chatbox' });

	const input = (await findByTestId('chat-history-limit-input')) as HTMLInputElement;
	await user.clear(input);
	// number inputs reject letters, so set the value directly to an empty string
	// then save — Number.parseInt('') is NaN.
	await user.click(await findByTestId('chat-history-limit-save'));

	const error = await findByTestId('chat-history-limit-error');
	expect(error.textContent).toMatch(/whole number/);
});

// Happy path: a valid in-range save persists and the input reflects the
// server-echoed value (the try branch + setValue).
test('a valid history limit saves and the input echoes the persisted value', async () => {
	const target = CHAT_HISTORY_LIMIT_MIN + 5;
	const { findByTestId, user } = await renderApp({ initialPath: '/settings/chatbox' });

	const input = (await findByTestId('chat-history-limit-input')) as HTMLInputElement;
	await user.clear(input);
	await user.type(input, String(target));
	await user.click(await findByTestId('chat-history-limit-save'));

	await waitFor(() => expect(input.value).toBe(String(target)));
});
