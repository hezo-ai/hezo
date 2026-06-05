import { test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedWorkspace } from './helpers/seed';

test('superuser saves the team as a new type from settings', async () => {
	let teamSlug = '';
	const { findByPlaceholderText, getByTestId, findByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			teamSlug = ws.team.slug;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/settings/general',
		params: { teamId: teamSlug },
	});

	await user.type(await findByPlaceholderText('e.g. Web Squad'), 'My Saved Squad');
	await user.click(getByTestId('save-as-type-submit'));

	// The inline confirmation only renders after the snapshot POST succeeds (201).
	await findByTestId('save-as-type-success');
});
