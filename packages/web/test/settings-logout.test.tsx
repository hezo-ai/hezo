import { waitFor, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { api } from '../src/lib/api';
import { renderApp } from './helpers/render';

// The Settings menu carries a "Log out" action at the bottom, one per rendered
// nav (happy-dom mounts both the mobile and desktop variants since it doesn't
// apply the responsive `hidden`/`md:` classes). Both share the same handler.

test('settings menu shows a Log out action at the bottom of the nav', async () => {
	const { findByTestId, getAllByTestId } = await renderApp({ initialPath: '/settings' });

	// The desktop nav renders the menu items followed by the Log out button.
	const desktopNav = await findByTestId('settings-nav-desktop');
	const logout = within(desktopNav).getByTestId('settings-logout');
	expect(logout.textContent).toContain('Log out');
	// It is the last child of the nav (pinned to the bottom after the links).
	expect(desktopNav.lastElementChild).toBe(logout);

	// Every nav variant exposes the action.
	expect(getAllByTestId('settings-logout').length).toBeGreaterThanOrEqual(1);
});

test('logging out clears the session and drops to the admin-password sign-in screen', async () => {
	const { findByTestId, getAllByTestId, user } = await renderApp({ initialPath: '/settings' });

	// Sanity: the app is signed in (settings chrome rendered, token present).
	await findByTestId('settings-nav-desktop');
	expect(api.getToken()).not.toBeNull();

	await user.click(getAllByTestId('settings-logout')[0]);

	// The token is gone and the top-level gate re-runs the `me` probe, which
	// 401s without a session and renders the admin-password sign-in screen.
	await waitFor(() => expect(api.getToken()).toBeNull());
	await findByTestId('password-login');
});
