import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';

/**
 * Route the provider catalog call (a live fetch inside the `/models` route) to a
 * fixed model list. Everything else keeps flowing through the harness fetch that
 * proxies `/api` to the in-process app. Returns the models it will serve.
 */
function stubProviderCatalog(ids: string[]): void {
	const harnessFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = input instanceof Request ? input.url : String(input);
		if (url.includes('/v1/models') || url.includes('api.anthropic.com')) {
			return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}
		return harnessFetch(input as RequestInfo | URL, init);
	}) as typeof fetch;
}

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
	// Opening the override form fetches provider catalogs for the id-suggestion
	// datalist; stub it so the test doesn't reach the real network.
	stubProviderCatalog(['claude-opus-4-8']);
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

test('the override model-id field suggests models from configured providers via a datalist', async () => {
	// The default seed leaves one verified anthropic (api_key) provider configured,
	// whose live catalog we stub. Opening the form fans the catalog fetch out over
	// verified providers and offers the results as datalist suggestions.
	stubProviderCatalog(['claude-opus-4-8', 'claude-sonnet-4-6']);

	const { findByRole, getByRole, container, user } = await renderApp({
		initialPath: '/settings/ai-providers',
	});

	await findByRole('heading', { name: 'Model pricing' });
	await user.click(getByRole('button', { name: 'Override' }));

	// The input is wired to the datalist, and the datalist fills from the fetched
	// catalog once the query resolves. The field itself stays free-text.
	expect(container.querySelector('input[list="model-pricing-model-ids"]')).toBeTruthy();

	await waitFor(
		() => {
			const datalist = container.querySelector('#model-pricing-model-ids');
			const values = Array.from(datalist?.querySelectorAll('option') ?? []).map((o) =>
				o.getAttribute('value'),
			);
			expect(values).toContain('claude-opus-4-8');
			expect(values).toContain('claude-sonnet-4-6');
		},
		{ timeout: 10_000 },
	);
});

test('the override form opens in a titled panel and closes via its close button', async () => {
	stubProviderCatalog(['claude-opus-4-8']);
	const { findByRole, getByRole, getByTestId, queryByTestId, user } = await renderApp({
		initialPath: '/settings/ai-providers',
	});

	await findByRole('heading', { name: 'Model pricing' });
	await user.click(getByRole('button', { name: 'Override' }));
	expect(getByTestId('in-place-form').textContent).toContain('Add price override');

	await user.click(getByTestId('in-place-form-close'));
	expect(queryByTestId('in-place-form')).toBeNull();
});

test('the Model pricing help dialog explains table-only pricing and how cache is rated', async () => {
	const { findByTestId, findByText, queryByText, user } = await renderApp({
		initialPath: '/settings/ai-providers',
	});

	// The explanation lives behind the help button, not inline — the old inline
	// paragraph duplicating the dialog must not render under the heading.
	const help = await findByTestId('model-pricing-help', undefined, { timeout: 10_000 });
	expect(queryByText('How run costs are calculated')).toBeNull();
	expect(queryByText(/Every agent run is priced from this table/)).toBeNull();

	await user.click(help);

	// The modal states the model: the table prices every run (runtime-reported
	// dollar figures are ignored), and cache traffic is rated from each model's
	// own input rate rather than billed at it.
	await findByText('How run costs are calculated');
	await findByText(/Every run is priced from this table/);
	await findByText(/derives them from each model's own input\s+rate/);
	// The old (wrong) precedence claim — runtime-reported cost wins — is gone.
	expect(queryByText(/Reported by the run/)).toBeNull();
});
