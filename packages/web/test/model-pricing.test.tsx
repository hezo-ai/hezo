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

test('model pricing lists the baked catalog plus overrides and creates an override', async () => {
	const { findByText, findByRole, getByRole, getByPlaceholderText, user } = await renderApp({
		initialPath: '/settings/ai-providers',
		seed: async (ctx) => {
			await seedOverride(ctx, {
				model_id: 'seeded-custom-model',
				input_per_token: 0.000987,
				output_per_token: 0.000015,
			});
		},
	});

	// The merged page leads with the AI providers section, then the model
	// pricing section below it.
	await findByRole('heading', { name: 'AI providers' });
	await findByRole('heading', { name: 'Model pricing' });

	// The blurb states the single source and the conservative posture.
	await findByText(/Rates refresh daily from/);

	// The migration-baked catalog renders alongside the seeded manual row.
	await findByText('claude-opus-4.8', undefined, { timeout: 10_000 });
	await findByText('seeded-custom-model');
	await findByText('$987.00');

	// Open the override form and add a model the catalog doesn't carry.
	await user.click(getByRole('button', { name: 'Override' }));
	await user.type(getByPlaceholderText('Model id (e.g. my-custom-model)'), 'my-fine-tune');
	await user.type(getByPlaceholderText('Input $ / Mtok'), '0.5');
	await user.type(getByPlaceholderText('Output $ / Mtok'), '1.5');
	await user.click(getByRole('button', { name: 'Save override' }));

	// The new override appears after the invalidate + refetch.
	await findByText('my-fine-tune');
});

test('the override form opens in a titled panel and closes via its close button', async () => {
	const { findByRole, getByRole, getByTestId, queryByTestId, user } = await renderApp({
		initialPath: '/settings/ai-providers',
	});

	await findByRole('heading', { name: 'Model pricing' });
	await user.click(getByRole('button', { name: 'Override' }));
	expect(getByTestId('in-place-form').textContent).toContain('Add price override');

	await user.click(getByTestId('in-place-form-close'));
	expect(queryByTestId('in-place-form')).toBeNull();
});

test('the Model pricing help dialog explains table-only pricing and the conservative estimate', async () => {
	const { findByTestId, findByText, queryByText, user } = await renderApp({
		initialPath: '/settings/ai-providers',
	});

	// The explanation lives behind the help button, not inline.
	const help = await findByTestId('model-pricing-help', undefined, { timeout: 10_000 });
	expect(queryByText('How run costs are calculated')).toBeNull();

	await user.click(help);

	// The modal states the model: the table prices every run (runtime-reported
	// dollar figures are ignored), and the missing cache rates make recorded
	// costs a conservative upper bound.
	await findByText('How run costs are calculated');
	await findByText(/Every run is priced from this table/);
	await findByText(/cached reads and writes are billed at/);
	// The old (wrong) precedence claim — runtime-reported cost wins — is gone.
	expect(queryByText(/Reported by the run/)).toBeNull();
});
