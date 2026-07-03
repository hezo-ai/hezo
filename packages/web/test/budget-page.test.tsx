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

	// The subtitle discloses that costs are a conservative upper-bound estimate
	// (cache traffic is billed at the full input rate).
	await findByText(/conservative upper-bound estimate/);

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

test('Budget page: Project budget header has a single Edit link to the settings budget section', async () => {
	let teamSlug = '';

	const { findByTestId, findByRole, queryByRole, user, router } = await renderApp({
		initialPath: '/',
		strictMode: true,
		seed: async () => {
			const ws = await seedWorkspace();
			await seedProject(ws, { name: 'Budget Link' });
			teamSlug = ws.internalSlug;
		},
	});

	await router.navigate({ to: '/projects/$projectId/budget', params: { projectId: teamSlug } });

	// The per-window pencils are gone — caps are edited from settings now, not here.
	const editLink = await findByTestId('edit-project-budget-link');
	expect(queryByRole('button', { name: 'Edit Today cap' })).toBeNull();
	expect(queryByRole('button', { name: 'Edit This week cap' })).toBeNull();
	expect(queryByRole('button', { name: 'Edit This month cap' })).toBeNull();

	// The single header Edit affordance points at the project settings budget anchor.
	const href = editLink.closest('a')?.getAttribute('href') ?? '';
	expect(href).toContain(`/projects/${teamSlug}/settings`);
	expect(href).toContain('#budget');

	// Following it lands on the settings page, where the budget caps editor lives.
	await user.click(editLink);
	await findByTestId('edit-project-budget', undefined, { timeout: 15_000 });
	await findByRole('button', { name: 'Edit caps' });
});

test('Budget page: each agent card links to that agent’s settings budget section', async () => {
	let teamSlug = '';
	let agentSlug = '';
	let agentTitle = '';

	const { findByTestId, findByRole, findByText, user, router } = await renderApp({
		initialPath: '/',
		strictMode: true,
		seed: async () => {
			const ws = await seedWorkspace();
			// Every team agent surfaces in the per-agent budget list (spend or not).
			const agent = ws.agents.find((a) => a.slug === 'engineer') ?? ws.agents[0];
			agentSlug = agent.slug;
			agentTitle = agent.title;
			teamSlug = ws.internalSlug;
		},
	});

	await router.navigate({ to: '/projects/$projectId/budget', params: { projectId: teamSlug } });

	// The card carries a single Edit button pointing at the agent's settings budget anchor.
	const editLink = await findByTestId(`edit-agent-budget-${agentSlug}`, undefined, {
		timeout: 15_000,
	});
	const href = editLink.getAttribute('href') ?? '';
	expect(href).toContain(`/agents/${agentSlug}/settings`);
	expect(href).toContain('#budget');

	// Following it lands on that agent's settings page with its budget editor.
	await user.click(editLink);
	await findByRole('heading', { name: agentTitle }, { timeout: 15_000 });
	await findByText('Budget limits');
});

test('Budget page: project window columns render caps and the binding-window banner appears', async () => {
	let teamSlug = '';

	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const { apiBase } = getTestContext();
			teamSlug = ws.internalSlug;
			const agent = ws.agents[0];

			// Cap all three project windows so every WindowColumn renders a bar + % (not "no cap").
			// Caps must satisfy the cross-window floors (weekly ≥ daily×7, monthly ≥ weekly×52/12).
			const patchRes = await apiBase(`/api/projects/${ws.internalSlug}`, {
				method: 'PATCH',
				headers: ws.headers,
				body: JSON.stringify({
					daily_budget_cents: 1000,
					weekly_budget_cents: 10000,
					monthly_budget_cents: 50000,
				}),
			});
			if (!patchRes.ok) throw new Error(`seed: setting project caps failed (${patchRes.status})`);

			const projects = (await (await apiBase('/api/projects', { headers: ws.headers })).json()) as {
				data: Array<{ id: string; slug: string }>;
			};
			const projectId = projects.data.find((p) => p.slug === ws.internalSlug)?.id;

			// $9 of project spend → daily 90% (the binding window), weekly 45%, monthly 18%.
			await apiBase(`/api/projects/${ws.internalSlug}/costs`, {
				method: 'POST',
				headers: ws.headers,
				body: JSON.stringify({
					member_id: agent.id,
					amount_cents: 900,
					project_id: projectId,
					description: 'project spend',
				}),
			});
		},
	});

	await router.navigate({ to: '/projects/$projectId/budget', params: { projectId: teamSlug } });

	// The daily window renders its $10 cap and 90% usage against the progress bar.
	const daily = await findByTestId('budget-window-daily', undefined, { timeout: 15_000 });
	await waitFor(() => {
		expect(daily.textContent ?? '').toContain('$10.00');
		expect(daily.textContent ?? '').toContain('90%');
	});

	// The binding-window banner surfaces the daily window and links to raise its cap.
	const banner = await findByTestId('binding-window-banner');
	expect(banner.textContent ?? '').toContain('Raise daily cap');
});
