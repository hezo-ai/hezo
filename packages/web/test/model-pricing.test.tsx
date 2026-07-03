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

test('model pricing renders below the AI providers table and creates an override', async () => {
	const { findByText, findByRole, getByRole, getByPlaceholderText, user } = await renderApp({
		initialPath: '/settings/ai-providers',
		seed: async (ctx) => {
			await seedOverride(ctx, {
				model_id: 'seeded-model',
				input_per_token: 0.000003,
				output_per_token: 0.000015,
			});
		},
	});

	// The merged page leads with the AI providers section, then the model
	// pricing section below it.
	await findByRole('heading', { name: 'AI providers' });
	await findByRole('heading', { name: 'Model pricing' });
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

test('the Model pricing help dialog explains that costs always come from the table', async () => {
	const { findByTestId, findByText, queryByText, user } = await renderApp({
		initialPath: '/settings/ai-providers',
	});

	// The explanation lives behind the help button, not inline.
	const help = await findByTestId('model-pricing-help', undefined, { timeout: 10_000 });
	expect(queryByText('How run costs are calculated')).toBeNull();

	await user.click(help);

	// The modal states the policy: every run is priced from this table; the
	// runtimes' own reported figures are client-side estimates and are ignored.
	await findByText('How run costs are calculated');
	await findByText(/is computed from this table/);
	await findByText(/ignores reported figures/);
});
