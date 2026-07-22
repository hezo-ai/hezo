import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';

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

test('configures the Slack app: both tokens, mode toggles, slack identities', async () => {
	const { findByTestId, getByTestId, user } = await renderApp({
		initialPath: '/settings/chat-channels',
	});
	await findByTestId('slack-channel');

	// Save both tokens with coworker mode on and assistant (DM) mode off. The
	// channel stays disabled in this test so the adapter never dials slack.com.
	await user.type(getByTestId('slack-token'), 'xoxb-token-abc');
	await user.type(getByTestId('slack-app-token'), 'xapp-token-abc');
	await user.click(getByTestId('slack-dm-mode'));
	await user.click(getByTestId('slack-save'));

	// After the save + refetch, both tokens read as set (never echoed back).
	await expect
		.poll(async () => (getByTestId('slack-token') as HTMLInputElement).placeholder)
		.toContain('••');
	expect((getByTestId('slack-app-token') as HTMLInputElement).placeholder).toContain('••');

	// The config landed with the two-secret pattern + mode flags in metadata.
	const config = await getTestContext().db.query<{
		bot_token_secret: string | null;
		metadata: Record<string, unknown>;
	}>(`SELECT bot_token_secret, metadata FROM chat_channel_configs WHERE channel = 'slack'`);
	expect(config.rows[0].bot_token_secret).toBe('SLACK_BOT_TOKEN');
	expect(config.rows[0].metadata).toMatchObject({
		app_token_secret: 'SLACK_APP_TOKEN',
		dm_mode_enabled: false,
		group_mode_enabled: true,
	});

	// The identity allowlist form offers Slack (for DM/assistant mode).
	await user.selectOptions(getByTestId('identity-channel'), 'slack');
	await user.type(getByTestId('identity-external-id'), 'U0FAREZ');
	await user.click(getByTestId('identity-add'));
	const list = await findByTestId('identity-list');
	expect(list.textContent).toContain('U0FAREZ');
	expect(list.textContent?.toLowerCase()).toContain('slack');
});

test('configures the Discord bot: token, mode toggles, discord identities', async () => {
	const { findByTestId, getByTestId, user } = await renderApp({
		initialPath: '/settings/chat-channels',
	});
	await findByTestId('discord-channel');

	// Save the token with assistant (DM) mode off. The channel stays disabled in
	// this test so the adapter never dials discord.com.
	await user.type(getByTestId('discord-token'), 'discord-bot-token');
	await user.click(getByTestId('discord-dm-mode'));
	await user.click(getByTestId('discord-save'));

	// After the save + refetch, the token reads as set (never echoed back).
	await expect
		.poll(async () => (getByTestId('discord-token') as HTMLInputElement).placeholder)
		.toContain('••');

	// The config landed with the vault reference + mode flags in metadata.
	const config = await getTestContext().db.query<{
		bot_token_secret: string | null;
		metadata: Record<string, unknown>;
	}>(`SELECT bot_token_secret, metadata FROM chat_channel_configs WHERE channel = 'discord'`);
	expect(config.rows[0].bot_token_secret).toBe('DISCORD_BOT_TOKEN');
	expect(config.rows[0].metadata).toMatchObject({
		dm_mode_enabled: false,
		group_mode_enabled: true,
	});

	// The identity allowlist form offers Discord (for DM/assistant mode).
	await user.selectOptions(getByTestId('identity-channel'), 'discord');
	await user.type(getByTestId('identity-external-id'), '99887766554433');
	await user.click(getByTestId('identity-add'));
	const list = await findByTestId('identity-list');
	expect(list.textContent).toContain('99887766554433');
	expect(list.textContent?.toLowerCase()).toContain('discord');
});
