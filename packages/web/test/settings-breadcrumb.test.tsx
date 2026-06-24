import { waitFor, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';

test('settings subpage shows a breadcrumb back to the Settings page', async () => {
	const { findByRole, router, user } = await renderApp({
		initialPath: '/settings/credentials',
	});

	// The breadcrumb renders above the page content regardless of admin access.
	const nav = await findByRole('navigation', { name: 'Breadcrumb' });
	const back = within(nav).getByRole('link', { name: 'Settings' });

	await user.click(back);

	await waitFor(() => expect(router.state.location.pathname).toBe('/settings'));
	await findByRole('heading', { name: 'Settings' });
});
