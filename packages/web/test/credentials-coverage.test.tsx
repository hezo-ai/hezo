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

// Branch: me && !me.is_superuser → the "managed by the Admin" message instead of
// the form/table.
test('non-superuser sees the managed message instead of the credentials UI', async () => {
	const { findByText, queryByRole } = await renderApp({
		initialPath: '/settings/credentials',
		seed: async (ctx) => {
			await ctx.db.query('UPDATE users SET is_superuser = false');
		},
	});

	await findByText(/managed by the Admin/i);
	// The Add button (superuser affordance) is absent.
	expect(queryByRole('button', { name: 'Add' })).toBeNull();
});

// Branch: empty-state copy when there are no instance credentials.
test('shows the empty-state hint when no instance credentials exist', async () => {
	const { findByText } = await renderApp({ initialPath: '/settings/credentials' });

	await findByText('Credentials', { selector: 'h1' });
	await findByText(/No instance credentials yet/);
});

// Branch: validation guard — no hosts and "allow all" unchecked surfaces the
// inline error and does NOT create the secret.
test('submitting with no hosts and allow-all unchecked shows the validation error', async () => {
	const { findByText, getByRole, getByPlaceholderText, queryByText, user } = await renderApp({
		initialPath: '/settings/credentials',
	});

	await findByText('Credentials', { selector: 'h1' });
	await user.click(getByRole('button', { name: 'Add' }));
	await user.type(getByPlaceholderText('Name (e.g. SHARED_API_KEY)'), 'NOHOSTS_KEY');
	await user.type(getByPlaceholderText('Value'), 'sk-x');
	// Leave allowed hosts blank, leave "allow all" unchecked.
	await user.click(getByRole('button', { name: 'Add credential' }));

	await findByText(/Add at least one allowed host/);
	// Nothing was created — the new name never appears in a table row.
	expect(queryByText('NOHOSTS_KEY', { selector: '.font-mono' })).toBeNull();
});

// Branch: allow-all-hosts checked disables the hosts input and lets the create
// succeed without any host entry; the table renders the "all hosts" badge.
test('allow-all-hosts disables the hosts input and creates an all-hosts credential', async () => {
	const { findByText, getByRole, getByPlaceholderText, user } = await renderApp({
		initialPath: '/settings/credentials',
	});

	await findByText('Credentials', { selector: 'h1' });
	await user.click(getByRole('button', { name: 'Add' }));
	await user.type(getByPlaceholderText('Name (e.g. SHARED_API_KEY)'), 'ALLHOSTS_KEY');
	await user.type(getByPlaceholderText('Value'), 'sk-all');

	const hostsInput = getByPlaceholderText(/Allowed hosts/) as HTMLInputElement;
	expect(hostsInput.disabled).toBe(false);
	const allowAll = getByRole('checkbox', { name: /reach any host/i }) as HTMLInputElement;
	await user.click(allowAll);
	// Now the hosts input is disabled (the allowAllHosts branch).
	expect(hostsInput.disabled).toBe(true);

	await user.click(getByRole('button', { name: 'Add credential' }));

	// Row appears with the "all hosts" badge (the allow_all_hosts render branch).
	await findByText('ALLHOSTS_KEY');
	await findByText('all hosts');
});

// Branch: the "Add" button toggles the form closed when already open (the
// showForm ? resetForm() : openCreate() ternary).
test('Add toggles the form closed when it is already open', async () => {
	const { findByText, getByRole, queryByPlaceholderText, user } = await renderApp({
		initialPath: '/settings/credentials',
	});

	await findByText('Credentials', { selector: 'h1' });
	await user.click(getByRole('button', { name: 'Add' }));
	// Form is open.
	expect(queryByPlaceholderText('Name (e.g. SHARED_API_KEY)')).not.toBeNull();
	// Clicking Add again closes it (resetForm path).
	await user.click(getByRole('button', { name: 'Add' }));
	await waitFor(() => expect(queryByPlaceholderText('Name (e.g. SHARED_API_KEY)')).toBeNull());
});

// Branch: a credential with no allowed hosts and allow_all_hosts false renders
// the "no hosts" danger badge in the table.
test('a hostless credential renders the no-hosts badge', async () => {
	const { findByText, getByRole, getByPlaceholderText, user } = await renderApp({
		initialPath: '/settings/credentials',
		seed: async (ctx) => {
			// Seed normally with a host, then strip hosts in the DB so the table
			// renders the !allowed_hosts.length branch (the API rejects a hostless
			// non-all secret on create).
			await seedInstanceSecret(ctx, {
				name: 'STRIPPED_KEY',
				value: 'v',
				allowed_hosts: ['api.temp.example'],
			});
			await ctx.db.query(
				`UPDATE secrets SET allowed_hosts = ARRAY[]::text[] WHERE name = 'STRIPPED_KEY'`,
			);
		},
	});

	await findByText('STRIPPED_KEY');
	await findByText('no hosts');

	// Editing prefills the existing value-blank state; submitting without a host
	// re-triggers the inline validation error.
	await user.click(getByRole('button', { name: 'Edit STRIPPED_KEY' }));
	await user.click(getByRole('button', { name: 'Save changes' }));
	await findByText(/Add at least one allowed host/);
	// The new-value field is optional on edit (placeholder reflects that).
	expect(
		(getByPlaceholderText('New value (leave blank to keep)') as HTMLInputElement).required,
	).toBe(false);
});
