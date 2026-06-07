import { within } from '@testing-library/react';
import { test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedWorkspace } from './helpers/seed';

test('superuser refreshes a team from a type in settings', async () => {
	let teamSlug = '';
	const { findByTestId, getByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			teamSlug = ws.internalSlug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/team-settings/general',
		params: { projectId: teamSlug },
	});

	const select = (await findByTestId('apply-type-select')) as HTMLSelectElement;
	// Options come from the team-templates query; wait for one, then apply it.
	const startup = await within(select).findByRole('option', { name: 'Startup' });
	await user.selectOptions(select, startup);
	await user.click(getByTestId('apply-type-submit'));

	// The merge runs and reports a result (Startup onto a Startup team is a no-op merge).
	await findByTestId('apply-type-result');
});
