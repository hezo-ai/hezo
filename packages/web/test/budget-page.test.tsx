import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { seedProject, seedWorkspace } from './helpers/seed';

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

test('Budgets page renders per-day breakdown panels by agent and adapter', async () => {
	let teamSlug = '';

	const { findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const { apiBase } = getTestContext();
			const agent = ws.agents.find((a) => a.slug === 'engineer') ?? ws.agents[0];
			teamSlug = ws.internalSlug;

			const projects = (await (await apiBase('/api/projects', { headers: ws.headers })).json()) as {
				data: Array<{ id: string; slug: string }>;
			};
			const projectId = projects.data.find((p) => p.slug === ws.internalSlug)?.id;
			await apiBase(`/api/projects/${ws.internalSlug}/costs`, {
				method: 'POST',
				headers: ws.headers,
				body: JSON.stringify({
					member_id: agent.id,
					amount_cents: 120,
					project_id: projectId,
					description: 'a run',
				}),
			});
		},
	});

	await router.navigate({ to: '/projects/$projectId/budget', params: { projectId: teamSlug } });

	// Both stacked panels are present...
	await findByText('Spend per day by agent');
	await findByText('Spend per day by AI adapter');
	// ...and each renders its chart once the seeded cost flows through the breakdown
	// endpoints (project chart uses its own test id, so exactly two stacked charts).
	// The two breakdown queries resolve independently, so wait for both charts to mount
	// rather than letting findAllByTestId return after just the first.
	await waitFor(() => {
		expect(document.querySelectorAll('[data-testid="stacked-spend-chart"]').length).toBe(2);
	});
});

test('Budget page: editing limits inline updates the spend progress cards', async () => {
	let teamSlug = '';
	let projectId = '';

	const { findByTestId, findByRole, user, ctx, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Budget Inline' });
			teamSlug = ws.internalSlug;
			projectId = project.id;
		},
	});

	await router.navigate({ to: '/projects/$projectId/budget', params: { projectId: teamSlug } });

	// The progress display and the editor are one section: edit limits in place.
	await user.click(await findByTestId('edit-project-budget'));
	await user.click(await findByTestId('budget-daily-toggle'));
	const daily = (await findByTestId('budget-daily')) as HTMLInputElement;
	await user.clear(daily);
	await user.type(daily, '20');
	await user.click(await findByRole('button', { name: 'Save' }));

	// The window column (driven by budget-status) reflects the new $20 daily cap — i.e.
	// editing the cap refreshes the same progress display it lives in.
	await waitFor(
		() => {
			const col = document.querySelector('[data-testid="budget-window-daily"]');
			expect(col?.textContent ?? '').toContain('$20.00');
		},
		{ timeout: 15_000 },
	);
	await waitFor(async () => {
		const row = await ctx.db.query<{ daily_budget_cents: number }>(
			'SELECT daily_budget_cents FROM projects WHERE id = $1',
			[projectId],
		);
		expect(row.rows[0]?.daily_budget_cents).toBe(2000);
	});
});
