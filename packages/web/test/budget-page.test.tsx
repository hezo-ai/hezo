import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { seedWorkspace } from './helpers/seed';

test('Budgets page shows per-agent windows and flags an over-budget agent', async () => {
	let teamSlug = '';
	let overAgentSlug = '';

	const { findByText, findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const { apiBase } = getTestContext();
			const agent = ws.agents.find((a) => a.slug === 'engineer') ?? ws.agents[0];
			overAgentSlug = agent.slug;
			teamSlug = ws.internalSlug;

			// Give the agent a tiny daily limit, then record spend that exceeds it.
			await apiBase(`/api/projects/${ws.internalSlug}/agents/${agent.id}`, {
				method: 'PATCH',
				headers: ws.headers,
				body: JSON.stringify({ daily_budget_cents: 100 }),
			});
			const projects = (await (await apiBase('/api/projects', { headers: ws.headers })).json()) as {
				data: Array<{ id: string; slug: string }>;
			};
			const projectId = projects.data.find((p) => p.slug === ws.internalSlug)?.id;
			await apiBase(`/api/projects/${ws.internalSlug}/costs`, {
				method: 'POST',
				headers: ws.headers,
				body: JSON.stringify({
					member_id: agent.id,
					amount_cents: 250,
					project_id: projectId,
					description: 'over budget',
				}),
			});
		},
	});

	await router.navigate({ to: '/projects/$projectId/budget', params: { projectId: teamSlug } });

	// The agent row renders, is flagged over budget, and the project banner appears.
	await findByTestId(`agent-budget-row-${overAgentSlug}`);
	await findByText('Over budget');
	const banner = await findByTestId('budget-banner');
	expect(banner).toBeTruthy();
});
