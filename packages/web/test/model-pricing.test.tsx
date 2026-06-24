import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';

async function seedOverride(
	ctx: { token: string; apiBase: (p: string, i?: RequestInit) => Promise<Response> },
	body: Record<string, unknown>,
) {
	const res = await ctx.apiBase('/api/model-pricing', {
		method: 'POST',
		headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (res.status !== 201) throw new Error(`seed override failed: ${res.status}`);
}

test('lists a seeded override and creates a new one via the form', async () => {
	const { findByText, getByRole, getByPlaceholderText, user } = await renderApp({
		initialPath: '/settings/model-pricing',
		seed: async (ctx) => {
			await seedOverride(ctx, {
				model_id: 'seeded-model',
				input_per_token: 0.000003,
				output_per_token: 0.000015,
			});
		},
	});

	// Heading + the seeded override (and its $/Mtok rendering) show.
	await findByText('Model pricing', { selector: 'h1' });
	await findByText('seeded-model');
	await findByText('$3.00');

	// Open the override form and add a model the feed doesn't carry.
	await user.click(getByRole('button', { name: 'Override' }));
	await user.type(getByPlaceholderText('Model id (e.g. deepseek-v4-pro)'), 'deepseek-v4-pro');
	await user.type(getByPlaceholderText('Input $ / Mtok'), '0.5');
	await user.type(getByPlaceholderText('Output $ / Mtok'), '1.5');
	await user.click(getByRole('button', { name: 'Save override' }));

	// The new override appears after the invalidate + refetch.
	await findByText('deepseek-v4-pro');
});

test('settings page shows the superuser Model pricing link and navigates to it', async () => {
	const { findByRole, getAllByRole, user, router } = await renderApp({ initialPath: '/settings' });

	await findByRole('heading', { name: 'Settings' });
	const link = await waitFor(() => {
		const found = getAllByRole('link', { name: 'Model pricing' }).find(
			(l) => l.getAttribute('href') === '/settings/model-pricing',
		);
		expect(found).toBeTruthy();
		return found as HTMLElement;
	});
	await user.click(link);

	expect(router.state.location.pathname).toBe('/settings/model-pricing');
	await findByRole('heading', { name: 'Model pricing' });
});
