import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';

async function seedInstanceSecret(
	ctx: { token: string; apiBase: (p: string, i?: RequestInit) => Promise<Response> },
	body: Record<string, unknown>,
) {
	const res = await ctx.apiBase('/api/secrets', {
		method: 'POST',
		headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (res.status !== 201) throw new Error(`seed secret failed: ${res.status}`);
}

test('lists seeded instance credentials and creates a new one via the form', async () => {
	const { findByText, getByRole, getByPlaceholderText, user } = await renderApp({
		initialPath: '/settings/credentials',
		seed: async (ctx) => {
			await seedInstanceSecret(ctx, {
				name: 'SEEDED_KEY',
				value: 'v1',
				allowed_hosts: ['api.seeded.example'],
			});
		},
	});

	// Heading + the seeded credential render.
	await findByText('Credentials');
	await findByText('SEEDED_KEY');

	// Open the create form and add a new credential.
	await user.click(getByRole('button', { name: 'Add' }));
	await user.type(getByPlaceholderText('Name (e.g. SHARED_API_KEY)'), 'NEW_KEY');
	await user.type(getByPlaceholderText('Value'), 'sk-new-123');
	await user.type(getByPlaceholderText(/Allowed hosts/), 'api.new.example');
	await user.click(getByRole('button', { name: 'Add credential' }));

	// The new credential appears after the invalidate + refetch.
	await findByText('NEW_KEY');
});

test('edits an instance credential host policy via the row edit affordance', async () => {
	const { findByText, getByRole, getByPlaceholderText, user } = await renderApp({
		initialPath: '/settings/credentials',
		seed: async (ctx) => {
			await seedInstanceSecret(ctx, {
				name: 'EDIT_ME',
				value: 'v1',
				allowed_hosts: ['api.old.example'],
			});
		},
	});

	await findByText('EDIT_ME');
	await findByText('api.old.example');

	// Open the row's edit form, change the allowed hosts, save.
	await user.click(getByRole('button', { name: 'Edit EDIT_ME' }));
	const hostsInput = getByPlaceholderText(/Allowed hosts/) as HTMLInputElement;
	await user.clear(hostsInput);
	await user.type(hostsInput, 'api.new.example');
	await user.click(getByRole('button', { name: 'Save changes' }));

	// After the invalidate + refetch the table shows the new host policy.
	await findByText('api.new.example');
});

test('settings page shows the superuser Credentials link and navigates to it', async () => {
	const { findByRole, getAllByRole, user, router } = await renderApp({ initialPath: '/settings' });

	await findByRole('heading', { name: 'Settings' });
	// The team sidebar also renders a "Credentials" link; pick the instance-scoped one by href.
	const sidebarLink = await waitFor(() => {
		const link = getAllByRole('link', { name: 'Credentials' }).find(
			(l) => l.getAttribute('href') === '/settings/credentials',
		);
		expect(link).toBeTruthy();
		return link as HTMLElement;
	});
	await user.click(sidebarLink);

	expect(router.state.location.pathname).toBe('/settings/credentials');
	await findByRole('heading', { name: 'Credentials' });
});
