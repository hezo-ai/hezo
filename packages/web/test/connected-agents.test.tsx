import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';

type SeedCtx = {
	token: string;
	apiBase: (p: string, i?: RequestInit) => Promise<Response>;
	db: { query: (sql: string) => Promise<unknown> };
};

async function register(ctx: SeedCtx, name: string): Promise<{ id: string }> {
	const res = await ctx.apiBase('/api/agent-connections/register', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ name }),
	});
	if (res.status !== 201) throw new Error(`register failed: ${res.status}`);
	return (await res.json()).data;
}

async function registerApproved(ctx: SeedCtx, name: string): Promise<void> {
	const { id } = await register(ctx, name);
	const res = await ctx.apiBase(`/api/agent-connections/${id}/approve`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${ctx.token}` },
	});
	if (res.status !== 200) throw new Error(`approve failed: ${res.status}`);
}

test('lists pending + connected agents and approving moves a row to Connected', async () => {
	const { findByRole, findByText, getByRole, user } = await renderApp({
		initialPath: '/settings/connected-agents',
		seed: async (ctx) => {
			await register(ctx as SeedCtx, 'alpha-pending');
			await registerApproved(ctx as SeedCtx, 'beta-online');
		},
	});

	await findByRole('heading', { name: 'Connected agents' });
	// Blurb explaining what the page shows.
	await findByText(/full admin access/i);
	await findByText('alpha-pending');
	await findByText('beta-online');

	// Approve the single pending agent → the Pending group empties.
	await user.click(getByRole('button', { name: 'Approve' }));
	await findByText('No pending requests.');
	// The approved agent is still listed (now under Connected).
	await findByText('alpha-pending');
});

test('disconnect removes a connected agent', async () => {
	window.confirm = () => true;
	const { findByText, getByRole, queryByText } = await renderApp({
		initialPath: '/settings/connected-agents',
		seed: async (ctx) => {
			await registerApproved(ctx as SeedCtx, 'gamma-online');
		},
	});

	await findByText('gamma-online');
	getByRole('button', { name: 'Disconnect' }).click();

	await waitFor(() => expect(queryByText('gamma-online')).toBeNull());
});

test('non-superuser sees the managed message instead of the list', async () => {
	const { findByText } = await renderApp({
		initialPath: '/settings/connected-agents',
		seed: async (ctx) => {
			// Demote the seeded admin so `me.is_superuser` is false.
			await (ctx as SeedCtx).db.query('UPDATE users SET is_superuser = false');
		},
	});

	await findByText(/managed by the Admin/i);
});
