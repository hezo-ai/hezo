import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * Retired: the chatbox settings are a section of Chat, beside the external
 * channels. Kept as a redirect so a bookmark or a link in an older doc still
 * lands somewhere useful.
 */
export const Route = createFileRoute('/settings/chatbox')({
	beforeLoad: () => {
		throw redirect({ to: '/settings/chat-channels', replace: true });
	},
});
