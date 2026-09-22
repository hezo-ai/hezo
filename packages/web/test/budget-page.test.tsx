import { fireEvent, waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { seedProject, seedUsage, seedWorkspace } from './helpers/seed';

test("Budget page renders a named agent's generated avatar instead of initials", async () => {
	let teamSlug = '';
	let agentSlug = '';

	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const { apiBase } = getTestContext();
			const agent = ws.agents.find((candidate) => candidate.slug === 'engineer') ?? ws.agents[0];
			agentSlug = agent.slug;
			teamSlug = ws.internalSlug;

			const res = await apiBase(`/api/projects/${ws.internalSlug}/agents/${agent.id}`, {
				method: 'PATCH',
				headers: ws.headers,
				body: JSON.stringify({ human_name: 'Rowan', avatar_seed: 'budget-rowan' }),
			});
			if (!res.ok) throw new Error(`seed: setting agent identity failed (${res.status})`);
		},
	});

	await router.navigate({ to: '/projects/$projectId/budget', params: { projectId: teamSlug } });

	const row = await findByTestId(`agent-budget-row-${agentSlug}`, undefined, { timeout: 15_000 });
	expect(row.textContent).toContain('Rowan');
	expect(row.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
});

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

			// Give the agent a small daily limit, then record usage that exceeds it.
			await apiBase(`/api/projects/${ws.internalSlug}/agents/${agent.id}`, {
				method: 'PATCH',
				headers: ws.headers,
				body: JSON.stringify({ daily_budget_tokens: 1_000_000 }),
			});
			const projects = (await (await apiBase('/api/projects', { headers: ws.headers })).json()) as {
				data: Array<{ id: string; slug: string }>;
			};
			const projectId = projects.data.find((p) => p.slug === ws.internalSlug)?.id;
			await seedUsage({
				memberId: agent.id,
				projectId: projectId as string,
				inputTokens: 2_500_000,
				description: 'over budget',
			});
		},
	});

	await router.navigate({ to: '/projects/$projectId/budget', params: { projectId: teamSlug } });

	await findByText('Track spend and set caps for this project and its agents.');

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
			await seedUsage({
				memberId: agent.id,
				projectId: projectId as string,
				inputTokens: 120_000,
				outputTokens: 4_000,
				description: 'a run',
			});
		},
	});

	await router.navigate({ to: '/projects/$projectId/budget', params: { projectId: teamSlug } });

	// Both stacked panels are present...
	await findByText('Tokens per day by agent');
	await findByText('Tokens per day by AI adapter');
	// ...and each renders its chart once the seeded usage flows through the breakdown
	// endpoints (project chart uses its own test id, so exactly two stacked charts).
	// The two breakdown queries resolve independently, so wait for both charts to mount
	// rather than letting findAllByTestId return after just the first.
	await waitFor(() => {
		expect(document.querySelectorAll('[data-testid="stacked-usage-chart"]').length).toBe(2);
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
	await findByRole('button', { name: 'Edit limits' });
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
					daily_budget_tokens: 10_000_000,
					weekly_budget_tokens: 100_000_000,
					monthly_budget_tokens: 500_000_000,
				}),
			});
			if (!patchRes.ok) throw new Error(`seed: setting project caps failed (${patchRes.status})`);

			const projects = (await (await apiBase('/api/projects', { headers: ws.headers })).json()) as {
				data: Array<{ id: string; slug: string }>;
			};
			const projectId = projects.data.find((p) => p.slug === ws.internalSlug)?.id;

			// 9M project tokens → daily 90% (the binding window), weekly 9%, monthly 2%.
			await seedUsage({
				memberId: agent.id,
				projectId: projectId as string,
				inputTokens: 9_000_000,
				description: 'project usage',
			});
		},
	});

	await router.navigate({ to: '/projects/$projectId/budget', params: { projectId: teamSlug } });

	// The daily window renders its 10M-token cap and 90% usage against the progress bar.
	const daily = await findByTestId('budget-window-daily', undefined, { timeout: 15_000 });
	await waitFor(() => {
		expect(daily.textContent ?? '').toContain('9M');
		expect(daily.textContent ?? '').toContain('/ 10M');
		expect(daily.textContent ?? '').toContain('90%');
	});

	// The binding-window banner surfaces the daily window and links to raise its cap.
	const banner = await findByTestId('binding-window-banner');
	expect(banner.textContent ?? '').toContain('Today: closest to its limit');
	expect(banner.textContent ?? '').toContain('Raise the limit');
});

test('Budget page: saving an agent cap edit refreshes the status (no stale cache)', async () => {
	let teamSlug = '';
	let agentSlug = '';
	let headers: Record<string, string> = {};

	const { findByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const { apiBase } = getTestContext();
			const agent = ws.agents.find((a) => a.slug === 'engineer') ?? ws.agents[0];
			agentSlug = agent.slug;
			teamSlug = ws.internalSlug;
			headers = ws.headers;
			await apiBase(`/api/projects/${ws.internalSlug}/agents/${agent.id}`, {
				method: 'PATCH',
				headers: ws.headers,
				body: JSON.stringify({ monthly_budget_tokens: 30_000_000 }),
			});
		},
	});

	// Populate the budget-status cache with the old 30M-token monthly cap.
	await router.navigate({ to: '/projects/$projectId/budget', params: { projectId: teamSlug } });
	const row = await findByTestId(`agent-budget-row-${agentSlug}`, undefined, { timeout: 15_000 });
	await waitFor(() => expect(row.textContent ?? '').toContain('/ 30M'));

	// Raise the monthly cap to 50 million tokens through the agent settings form.
	await router.navigate({
		to: '/projects/$projectId/agents/$agentId/settings',
		params: { projectId: teamSlug, agentId: agentSlug },
	});
	const monthlyInput = await findByTestId('budget-monthly', undefined, { timeout: 15_000 });
	await user.clear(monthlyInput);
	await user.type(monthlyInput, '50');
	// happy-dom does not implicit-submit a form on click of a submit button;
	// dispatch the submit event directly.
	fireEvent.submit(monthlyInput.closest('form')!);

	// Wait for the save to land server-side before navigating back, so the only
	// question left is whether the client cache refetches.
	await waitFor(
		async () => {
			const { apiBase } = getTestContext();
			const res = await apiBase(`/api/projects/${teamSlug}/agents/${agentSlug}`, { headers });
			const body = (await res.json()) as { data?: { monthly_budget_tokens?: number } };
			expect(body.data?.monthly_budget_tokens).toBe(50_000_000);
		},
		{ timeout: 10_000 },
	);

	// Back on the Budget page the card must show the new cap right away — the
	// mutation invalidates budget-status; without that, the 60s staleTime would
	// keep serving the old cap from cache.
	await router.navigate({ to: '/projects/$projectId/budget', params: { projectId: teamSlug } });
	const updated = await findByTestId(`agent-budget-row-${agentSlug}`, undefined, {
		timeout: 15_000,
	});
	await waitFor(() => expect(updated.textContent ?? '').toContain('/ 50M'));
});

test("Team settings lists each agent's usage under the name the roster gives it", async () => {
	let teamSlug = '';

	const { router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const { apiBase } = getTestContext();
			const agent = ws.agents.find((candidate) => candidate.slug === 'engineer') ?? ws.agents[0];
			teamSlug = ws.internalSlug;
			await apiBase(`/api/projects/${ws.internalSlug}/agents/${agent.id}`, {
				method: 'PATCH',
				headers: ws.headers,
				body: JSON.stringify({ human_name: 'Rowan' }),
			});
			const projects = (await (await apiBase('/api/projects', { headers: ws.headers })).json()) as {
				data: Array<{ id: string; slug: string }>;
			};
			await seedUsage({
				memberId: agent.id,
				projectId: projects.data.find((p) => p.slug === ws.internalSlug)?.id as string,
				inputTokens: 1_234_000,
			});
		},
	});

	await router.navigate({
		to: '/projects/$projectId/team-settings/general',
		params: { projectId: teamSlug },
	});

	await waitFor(
		() => {
			const section = document.querySelector('#settings-budget')?.textContent ?? '';
			expect(section).toContain('Rowan');
			expect(section).toContain('1,234,000');
		},
		{ timeout: 15_000 },
	);
});
