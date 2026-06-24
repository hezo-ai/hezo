import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';

type SeedCtx = {
	token: string;
	apiBase: (p: string, i?: RequestInit) => Promise<Response>;
	db: { query: (sql: string) => Promise<unknown> };
};

async function register(ctx: SeedCtx, name: string): Promise<{ id: string }> {
	const res = await ctx.apiBase('/api/api-keys/register', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ name }),
	});
	if (res.status !== 201) throw new Error(`register failed: ${res.status}`);
	return (await res.json()).data;
}

async function registerApproved(ctx: SeedCtx, name: string): Promise<void> {
	const { id } = await register(ctx, name);
	const res = await ctx.apiBase(`/api/api-keys/${id}/approve`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${ctx.token}` },
	});
	if (res.status !== 200) throw new Error(`approve failed: ${res.status}`);
}

test('lists pending + active keys and approving moves a row to Active', async () => {
	const { findByRole, findByText, getByRole, queryByText, user } = await renderApp({
		initialPath: '/settings/api-keys',
		seed: async (ctx) => {
			await register(ctx as SeedCtx, 'alpha-pending');
			await registerApproved(ctx as SeedCtx, 'beta-online');
		},
	});

	await findByRole('heading', { name: 'API keys' });
	await findByText(/full access/i);
	await findByText('alpha-pending');
	await findByText('beta-online');
	await findByText('Pending approval');

	// Approve the single pending key → the Pending group disappears.
	await user.click(getByRole('button', { name: 'Approve' }));
	await waitFor(() => expect(queryByText('Pending approval')).toBeNull());
	// The approved key is still listed (now under Active).
	await findByText('alpha-pending');
});

test('revoke removes an active key', async () => {
	window.confirm = () => true;
	const { findByText, getByRole, queryByText } = await renderApp({
		initialPath: '/settings/api-keys',
		seed: async (ctx) => {
			await registerApproved(ctx as SeedCtx, 'gamma-online');
		},
	});

	await findByText('gamma-online');
	getByRole('button', { name: 'Revoke' }).click();

	await waitFor(() => expect(queryByText('gamma-online')).toBeNull());
});

test('an admin can mint a new key and see it once', async () => {
	const { findByText, getByRole, getByPlaceholderText, user } = await renderApp({
		initialPath: '/settings/api-keys',
	});

	await findByText(/full access/i);
	await user.click(getByRole('button', { name: 'Create' }));
	await user.type(getByPlaceholderText('Key name'), 'minted-key{Enter}');

	// The raw key is revealed once.
	await findByText(/copy it now/i);
	await findByText(/^hezo_/);
	// And the key is now listed under Active.
	await findByText('minted-key');
});

test('non-superuser sees the managed message instead of the list', async () => {
	const { findByText } = await renderApp({
		initialPath: '/settings/api-keys',
		seed: async (ctx) => {
			// Demote the seeded admin so `me.is_superuser` is false.
			await (ctx as SeedCtx).db.query('UPDATE users SET is_superuser = false');
		},
	});

	await findByText(/managed by the Admin/i);
});
