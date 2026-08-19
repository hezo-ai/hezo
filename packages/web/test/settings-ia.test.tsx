import { within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';

// The regrouped Settings menu, the two page merges and their redirects.
// happy-dom applies no responsive classes, so both nav variants mount; every
// assertion here scopes to the desktop one.

test('the settings menu is grouped, and each group heading precedes its items', async () => {
	const { findByTestId } = await renderApp({ initialPath: '/settings' });
	const nav = await findByTestId('settings-nav-desktop');
	const text = nav.textContent ?? '';

	for (const heading of ['General', 'Agents', 'Integrations', 'Access', 'Maintenance']) {
		expect(text, `missing group heading ${heading}`).toContain(heading);
	}

	// Order matters: a heading labels what follows it, so Appearance must sit
	// under General rather than drifting into the next group.
	expect(text.indexOf('General')).toBeLessThan(text.indexOf('Appearance'));
	expect(text.indexOf('Appearance')).toBeLessThan(text.indexOf('Agents'));
	expect(text.indexOf('Agents')).toBeLessThan(text.indexOf('AI providers'));
	expect(text.indexOf('Integrations')).toBeLessThan(text.indexOf('Connectors'));
	expect(text.indexOf('Access')).toBeLessThan(text.indexOf('Users & access'));
	expect(text.indexOf('Maintenance')).toBeLessThan(text.indexOf('Storage'));
});

test('a group heading is a label, not another link in the menu', async () => {
	const { findByTestId } = await renderApp({ initialPath: '/settings' });
	const nav = await findByTestId('settings-nav-desktop');

	// The headings read as links only if they *are* reachable as one. Every
	// interactive node in the menu is a nav item or the log-out button; a group
	// title is neither, so it must not turn up among them.
	const interactive = within(nav)
		.getAllByRole('link')
		.map((el) => el.textContent?.trim());
	for (const heading of ['General', 'Agents', 'Integrations', 'Access', 'Maintenance']) {
		expect(interactive, `${heading} is reachable as a link`).not.toContain(heading);
	}
});

test('the retired pages are gone from the menu and their subjects live on', async () => {
	const { findByTestId } = await renderApp({ initialPath: '/settings' });
	const nav = await findByTestId('settings-nav-desktop');
	const links = within(nav)
		.getAllByRole('link')
		.map((a) => a.getAttribute('href'));

	expect(links).not.toContain('/settings/admin-password');
	expect(links).not.toContain('/settings/chatbox');
	expect(links).toContain('/settings/users');
	expect(links).toContain('/settings/chat-channels');
	expect(links).toContain('/settings/appearance');
	// The former General page kept its route and took the Instance label.
	expect(links).toContain('/settings');
	expect(nav.textContent).toContain('Instance');
});

test('a non-superuser sees only the pages open to them', async () => {
	const { findByTestId } = await renderApp({
		initialPath: '/settings',
		seed: async (ctx) => {
			await ctx.db.query('UPDATE users SET is_superuser = false');
		},
	});
	const nav = await findByTestId('settings-nav-desktop');
	const links = within(nav)
		.getAllByRole('link')
		.map((a) => a.getAttribute('href'));

	expect(links).toContain('/settings/appearance');
	expect(links).toContain('/settings/ai-providers');
	expect(links).not.toContain('/settings/users');
	expect(links).not.toContain('/settings/storage');
	// A group with nothing left in it is not rendered as a bare heading.
	expect(nav.textContent).not.toContain('Maintenance');
});

test('/settings/admin-password redirects to Users & access, password form intact', async () => {
	const { findByRole, findByLabelText, router } = await renderApp({
		initialPath: '/settings/admin-password',
	});

	// By role, not by text: the label also appears in the nav beside the page.
	await findByRole('heading', { name: 'Users & access', level: 1 });
	await findByLabelText('Current password');
	expect(router.state.location.pathname).toBe('/settings/users');
});

test('/settings/chatbox redirects to Chat, chatbox settings intact', async () => {
	const { findByTestId, router } = await renderApp({ initialPath: '/settings/chatbox' });

	await findByTestId('chatbox-section');
	await findByTestId('chat-history-size-input');
	expect(router.state.location.pathname).toBe('/settings/chat-channels');
});
