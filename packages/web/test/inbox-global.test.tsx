import { test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedWorkspace } from './helpers/seed';

test('global inbox route mounts across all of the user teams', async () => {
	const { findByRole } = await renderApp({
		initialPath: '/home/inbox',
		seed: async () => {
			await seedWorkspace();
			await seedWorkspace();
		},
	});
	// The /home/inbox route mounts InboxView in global scope (aggregating every
	// team the user belongs to). The page heading distinguishes it from the
	// sidebar's per-team "Inbox" link.
	await findByRole('heading', { name: 'Inbox' });
});
