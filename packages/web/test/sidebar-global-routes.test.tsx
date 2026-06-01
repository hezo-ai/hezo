import { DEFAULT_TEAM_SLUG } from '@hezo/shared';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedWorkspace } from './helpers/seed';

test('sidebar renders on /home with links pointing at the default team', async () => {
	const { container, findByText, getByRole, user, router } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			// Seed a workspace so the sidebar has data to display.
			await seedWorkspace();
		},
	});

	await findByText('Resources', undefined, { timeout: 10_000 });

	const nav = container.querySelector('nav') as HTMLElement;
	expect(nav).toBeTruthy();
	expect(nav.textContent).toMatch(/Inbox/);
	expect(nav.textContent).toMatch(/All Tasks/);
	expect(nav.textContent).toMatch(/Projects/);
	expect(nav.textContent).toMatch(/Team/);
	expect(nav.textContent).toMatch(/Resources/);

	// Clicking Inbox in the sidebar navigates to the default team's inbox.
	const inboxLink = getByRole('link', { name: 'Inbox' });
	await user.click(inboxLink);
	expect(router.state.location.pathname).toBe(`/teams/${DEFAULT_TEAM_SLUG}/inbox`);
});

test('sidebar renders on /settings', async () => {
	const { container, findByText, router } = await renderApp({
		initialPath: '/settings',
		seed: async () => {
			await seedWorkspace();
		},
	});

	await findByText('Resources', undefined, { timeout: 10_000 });
	const nav = container.querySelector('nav') as HTMLElement;
	expect(nav.textContent).toMatch(/Inbox/);
	// We arrived at /settings without any team route.
	expect(router.state.location.pathname).toBe('/settings');
});

test('sidebar renders on /settings/ai-providers', async () => {
	const { container, findByText, router } = await renderApp({
		initialPath: '/settings/ai-providers',
		seed: async () => {
			await seedWorkspace();
		},
	});

	await findByText('Resources', undefined, { timeout: 10_000 });
	const nav = container.querySelector('nav') as HTMLElement;
	expect(nav.textContent).toMatch(/Inbox/);
	expect(router.state.location.pathname).toBe('/settings/ai-providers');
});
