// The Budget page on an instance whose runs are all on subscriptions.
//
// Those runs charge nobody, so every billed figure is $0 - and the page used to
// answer that with "No spend recorded." over an empty chart, which reads as an
// idle fleet rather than a busy one nobody is invoicing. The costs endpoints are
// fetch-mocked because a notional cost row cannot be seeded through the API
// (POST /costs records real money by definition); the server's own split is
// covered in packages/server/test. Render-driven, so this is the component tier.

import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedWorkspace } from './helpers/seed';

const NOTIONAL_CENTS = 412_030;

/** A day bucket inside the current UTC month, so the month-to-date roll-up sees it. */
function todayUtc(): string {
	return new Date().toISOString().slice(0, 10);
}

let restoreFetch: (() => void) | null = null;

/**
 * Serve every cost read as subscription spend: nothing billed, everything
 * notional. The ungrouped branch is never hit by this page.
 */
function installCostsMock(agentId: string) {
	const original = globalThis.fetch;
	restoreFetch = () => {
		globalThis.fetch = original;
	};
	const day = todayUtc();
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : (input as Request).url;
		const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
		if (method === 'GET' && /\/api\/projects\/[^/]+\/costs(\?.*)?$/.test(url)) {
			const breakdown = new URL(url, 'http://localhost').searchParams.get('breakdown');
			const row =
				breakdown === 'agent'
					? {
							day,
							agent_id: agentId,
							agent_title: 'Captain',
							agent_name: null,
							total_cents: 0,
							notional_cents: NOTIONAL_CENTS,
						}
					: breakdown === 'adapter'
						? {
								day,
								ai_provider_config_id: null,
								provider: 'openai',
								adapter_label: 'Codex subscription',
								total_cents: 0,
								notional_cents: NOTIONAL_CENTS,
							}
						: { day, total_cents: 0, notional_cents: NOTIONAL_CENTS };
			return new Response(
				JSON.stringify({
					data: { summary: [row], total_cents: 0, notional_cents: NOTIONAL_CENTS },
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			);
		}
		return original(input as RequestInfo, init);
	}) as typeof globalThis.fetch;
}

test('subscription-only spend is charted and explained, and left out of the caps', async () => {
	let teamSlug = '';
	const { findByTestId, queryByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			teamSlug = ws.internalSlug;
			installCostsMock(ws.agents[0].id);
		},
	});

	try {
		await router.navigate({ to: '/projects/$projectId/budget', params: { projectId: teamSlug } });

		// The note names the amount and says nobody paid it.
		const note = await findByTestId('notional-spend-note', undefined, { timeout: 20_000 });
		expect(note.textContent).toContain('$4,120.30');
		expect(note.textContent).toContain('nobody was billed for');
		expect(note.textContent).toContain('counts towards no budget cap');

		// The charts have data to draw rather than the "no spend" placeholder that
		// made a busy fleet look idle.
		await findByTestId('budget-chart');
		// Two panels share the id (by agent, by adapter), so count rather than find.
		await waitFor(() => {
			expect(document.querySelectorAll('[data-testid="stacked-spend-chart"]').length).toBe(2);
		});
		expect(queryByText('No spend recorded.')).toBeNull();

		// The hero carries the figure beside its billed total...
		const heroNotional = await findByTestId('budget-month-notional');
		expect(heroNotional.textContent).toBe('$4,120.30 not billed');
		// ...and the billed total itself is untouched, because no cap moved.
		const heroSpend = await findByTestId('budget-month-spend');
		expect(heroSpend.textContent).toBe('$0.00');
	} finally {
		restoreFetch?.();
		restoreFetch = null;
	}
});
