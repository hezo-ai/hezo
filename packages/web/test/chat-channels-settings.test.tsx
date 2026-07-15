import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';

// The chat-channels settings page is backed by the admin REST routes (no
// ChatSessionManager needed). Drives the Telegram config + identity allowlist
// end-to-end against the in-process backend.

test('configures the Telegram bot and links an identity', async () => {
	const { findByRole, findByTestId, getByTestId, user } = await renderApp({
		initialPath: '/settings/chat-channels',
	});

	await findByRole('heading', { name: 'Chat channels' });
	await findByTestId('telegram-channel');

	// Enable + save a bot token.
	await user.click(getByTestId('telegram-enabled'));
	await user.type(getByTestId('telegram-token'), 'bot-token-abc');
	await user.type(getByTestId('telegram-group'), '-1005');
	await user.click(getByTestId('telegram-save'));

	// After the save + refetch, the token reads as set (never echoed back).
	await expect
		.poll(async () => (getByTestId('telegram-token') as HTMLInputElement).placeholder)
		.toContain('••');

	// Link a Telegram identity to the current admin.
	await user.type(getByTestId('identity-external-id'), '4242');
	await user.type(getByTestId('identity-handle'), '@me');
	await user.click(getByTestId('identity-add'));

	const list = await findByTestId('identity-list');
	// Handle is shown when set; the row also names the channel.
	expect(list.textContent).toContain('@me');
	expect(list.textContent?.toLowerCase()).toContain('telegram');
});
