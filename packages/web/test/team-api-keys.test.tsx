import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedWorkspace } from './helpers/seed';

/**
 * Exercises the team-settings API keys section, whose create/delete hooks were
 * migrated onto the response-driven + invalidating mutation factories. The
 * create flow also proves the mutation's returned data still carries the
 * one-time raw `key` (shown once) even though the list cache is seeded without
 * it.
 */

test('creates an API key, shows the raw key once, and lists it', async () => {
	let teamSlug = '';
	const { findByText, findByPlaceholderText, findByRole, container, user, router } =
		await renderApp({
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

	// Open the create form via the section's "Create" toggle (the only one until
	// the form mounts its own submit).
	await user.click(await findByRole('button', { name: 'Create' }));

	await user.type(await findByPlaceholderText('Key name'), 'CI Key');
	// Two buttons read "Create" once the form is open (the section toggle and the
	// form submit); target the submit by type.
	const submit = container.querySelector('button[type="submit"]');
	if (!submit) throw new Error('submit button not found');
	await user.click(submit as HTMLElement);

	// One-time raw key banner + the row appear after the refetch.
	await findByText("New API key created — copy it now, it won't be shown again:");
	await findByText('CI Key');
});

test('deletes an API key and it disappears from the list', async () => {
	let teamSlug = '';
	const { findByText, findByRole, queryByText, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			teamSlug = ws.team.slug;
			const { getTestContext } = await import('./helpers/render');
			const res = await getTestContext().apiBase(`/api/teams/${ws.team.id}/api-keys`, {
				method: 'POST',
				headers: ws.headers,
				body: JSON.stringify({ name: 'Doomed Key' }),
			});
			if (res.status !== 201) throw new Error(`seed api key failed: ${res.status}`);
		},
	});

	await router.navigate({
		to: '/teams/$teamId/settings/general',
		params: { teamId: teamSlug },
	});

	await findByText('Doomed Key');
	await user.click(await findByRole('button', { name: 'Delete Doomed Key' }));

	await expect.poll(() => queryByText('Doomed Key')).toBeNull();
});
