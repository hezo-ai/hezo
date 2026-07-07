import { DEFAULT_HEARTBEAT_INTERVAL_MIN } from '@hezo/shared';
import { fireEvent, waitFor, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { queryClient } from '../src/lib/query-client';
import { getTestContext, renderApp } from './helpers/render';
import { seedProject, seedTask, seedWorkspace } from './helpers/seed';

test('team org chart renders the CEO at the head with a status legend', async () => {
	let teamSlug = '';
	const { findByText, findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			teamSlug = ws.internalSlug;
		},
	});
	await router.navigate({ to: '/projects/$projectId/agents', params: { projectId: teamSlug } });
	await findByText('You (Admin)', undefined, { timeout: 15_000 });
	await findByText('Active', undefined, { timeout: 15_000 });
	// The instance CEO heads the chart (the Captain reports to it) even though it
	// lives in HQ. Scope to the chart itself — the CEO also shows in the global-
	// agents rail.
	const chart = await findByTestId('team-org-chart');
	await within(chart).findByText('CEO', undefined, { timeout: 15_000 });
});

test('agent detail page defaults to Executions tab and exposes Settings tab', async () => {
	let teamSlug = '';
	let agentId = '';
	const { getByRole, findByRole, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			teamSlug = ws.internalSlug;
			agentId = ws.agents[0].id;
		},
	});
	await router.navigate({
		to: '/projects/$projectId/agents/$agentId',
		params: { projectId: teamSlug, agentId },
	});

	const main = await findByRole('main');
	await waitFor(() => {
		// The active tab renders as a folder tab raised in front: its fill matches
		// the panel below (bg-bg) and its bottom border is removed so it merges in.
		const executionsLink = within(main).getByRole('link', { name: 'Executions' });
		expect(executionsLink.className).toMatch(/bg-bg/);
		expect(executionsLink.className).toMatch(/border-b-transparent/);
	});

	const settingsLink = within(getByRole('main')).getByRole('link', { name: 'Settings' });
	expect(settingsLink).toBeTruthy();
	// The inactive tab is recessed on the baseline (surface-2 fill, no merge).
	expect(settingsLink.className).toMatch(/bg-surface-2/);
});

test('agent settings tab shows budget, heartbeat, title, and save controls', async () => {
	let teamSlug = '';
	let agentId = '';
	const { findByLabelText, findByText, findByRole, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			teamSlug = ws.internalSlug;
			agentId = ws.agents[0].id;
		},
	});
	await router.navigate({
		to: '/projects/$projectId/agents/$agentId/settings',
		params: { projectId: teamSlug, agentId },
	});

	await findByText('Monthly spend');
	await findByText(`Every ${DEFAULT_HEARTBEAT_INTERVAL_MIN} min`);
	await findByLabelText('Title');
	await findByLabelText('Run timeout (min)');
	await findByRole('button', { name: 'Save Changes' });
});

test('agent settings persists run_timeout_min independently of heartbeat', async () => {
	let teamSlug = '';
	let teamId = '';
	let agentId = '';
	let originalHeartbeat = 0;

	const { findByLabelText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			teamSlug = ws.internalSlug;
			teamId = ws.team.id;
			const { apiBase, token } = getTestContext();
			const agentsRes = await apiBase(`/api/projects/${teamSlug}/agents`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			const agents = (
				(await agentsRes.json()) as {
					data: Array<{
						id: string;
						admin_status: string;
						heartbeat_interval_min: number;
					}>;
				}
			).data;
			const agent = agents.find((a) => a.admin_status === 'enabled') ?? agents[0];
			agentId = agent.id;
			originalHeartbeat = agent.heartbeat_interval_min;
		},
	});
	await router.navigate({
		to: '/projects/$projectId/agents/$agentId/settings',
		params: { projectId: teamSlug, agentId },
	});

	const runTimeoutInput = (await findByLabelText('Run timeout (min)')) as HTMLInputElement;
	fireEvent.change(runTimeoutInput, { target: { value: '23' } });

	// happy-dom does not implicit-submit a form on click of a submit button;
	// dispatch the submit event directly.
	const form = runTimeoutInput.closest('form')!;
	fireEvent.submit(form);

	// Wait for the PATCH to actually land before asserting persistence.
	const { apiBase, token } = getTestContext();
	await waitFor(
		async () => {
			const verifyRes = await apiBase(`/api/projects/${teamSlug}/agents/${agentId}`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			const verifyData = (
				(await verifyRes.json()) as {
					data: { run_timeout_min: number; heartbeat_interval_min: number };
				}
			).data;
			expect(verifyData.run_timeout_min).toBe(23);
			expect(verifyData.heartbeat_interval_min).toBe(originalHeartbeat);
		},
		{ timeout: 10_000 },
	);
});

test('agent settings tab edits the title and persists across reload', async () => {
	let teamSlug = '';
	let teamId = '';
	let agentId = '';
	let originalTitle = '';

	const { findByLabelText, findByRole, getByRole, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			teamSlug = ws.internalSlug;
			teamId = ws.team.id;
			const { apiBase, token } = getTestContext();
			const agentsRes = await apiBase(`/api/projects/${teamSlug}/agents`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			const agents = (
				(await agentsRes.json()) as {
					data: Array<{ id: string; title: string; admin_status: string }>;
				}
			).data;
			const agent = agents.find((a) => a.admin_status === 'enabled') ?? agents[0];
			agentId = agent.id;
			originalTitle = agent.title;
		},
	});
	await router.navigate({
		to: '/projects/$projectId/agents/$agentId',
		params: { projectId: teamSlug, agentId },
	});

	const main = await findByRole('main');
	const settingsLink = await within(main).findByRole('link', { name: 'Settings' });
	fireEvent.click(settingsLink);

	const titleInput = (await findByLabelText('Title')) as HTMLInputElement;
	fireEvent.change(titleInput, { target: { value: `${originalTitle} Updated` } });

	const form = titleInput.closest('form')!;
	fireEvent.submit(form);

	const { apiBase, token } = getTestContext();
	await waitFor(
		async () => {
			const verifyRes = await apiBase(`/api/projects/${teamSlug}/agents/${agentId}`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			const verifyData = ((await verifyRes.json()) as { data: { title: string } }).data;
			expect(verifyData.title).toBe(`${originalTitle} Updated`);
		},
		{ timeout: 10_000 },
	);
});

test('Captain settings disables the Reports To field with a fixed-line hint', async () => {
	let teamSlug = '';
	let captainId = '';
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			teamSlug = ws.internalSlug;
			captainId = ws.agents.find((a) => a.slug === 'captain')!.id;
		},
	});
	await router.navigate({
		to: '/projects/$projectId/agents/$agentId/settings',
		params: { projectId: teamSlug, agentId: captainId },
	});

	const hint = await findByTestId('reports-to-locked-hint');
	expect(hint.textContent).toMatch(/Captain always reports to the CEO/);
	const select = hint.closest('label')!.querySelector('select') as HTMLSelectElement;
	expect(select.disabled).toBe(true);
});

test('ordinary agent settings leaves the Reports To field editable', async () => {
	let teamSlug = '';
	let engineerId = '';
	const { findByText, queryByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			teamSlug = ws.internalSlug;
			engineerId = ws.agents.find((a) => a.slug === 'engineer')!.id;
		},
	});
	await router.navigate({
		to: '/projects/$projectId/agents/$agentId/settings',
		params: { projectId: teamSlug, agentId: engineerId },
	});

	// Wait for the settings form to render, then assert the select is enabled and
	// carries no fixed-line hint.
	const label = await findByText('Reports To');
	const select = label.closest('label')!.querySelector('select') as HTMLSelectElement;
	expect(select.disabled).toBe(false);
	expect(queryByTestId('reports-to-locked-hint')).toBeNull();
});

test('instance agent (CEO) settings shows an essential-role note and no disable button', async () => {
	let teamSlug = '';
	let ceoId = '';
	const { findByText, queryByRole, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			teamSlug = ws.internalSlug;
			// CEO/Coach surface as HQ virtual members of every project's roster.
			ceoId = ws.agents.find((a) => a.slug === 'ceo')!.id;
		},
	});
	await router.navigate({
		to: '/projects/$projectId/agents/$agentId/settings',
		params: { projectId: teamSlug, agentId: ceoId },
	});

	// The essential HQ role explains it's always active — and offers no disable button.
	await findByText(/essential HQ role/i);
	expect(queryByRole('button', { name: /Disable agent/i })).toBeNull();
});

test('agent header shows a live next-heartbeat countdown when the agent has work', async () => {
	let projectSlug = '';
	let agentId = '';
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			agentId = ws.agents[0].id;
			// Give the agent an actionable task; without one the indicator shows a
			// dash (the next heartbeat would no-op) rather than a countdown.
			const project = await seedProject(ws, { name: 'Demo' });
			await seedTask(ws, project, { title: 'Do work', assignee_id: agentId });
			projectSlug = ws.internalSlug; // seedProject reslugs the project
			// Stamp a recent heartbeat so next_heartbeat_at is ~an hour out and the
			// countdown renders a stable, non-due value.
			const { db } = getTestContext();
			await db.query(`UPDATE member_agents SET last_heartbeat_at = now() WHERE id = $1`, [agentId]);
		},
	});
	await router.navigate({
		to: '/projects/$projectId/agents/$agentId',
		params: { projectId: projectSlug, agentId },
	});

	const indicator = await findByTestId('next-heartbeat');
	expect(indicator.textContent).toMatch(/Next heartbeat in/);
});

test('agent header shows a dash when the agent has no work to do', async () => {
	let teamSlug = '';
	let agentId = '';
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			teamSlug = ws.internalSlug;
			agentId = ws.agents[0].id;
			// Detach any seeded task so the agent has nothing actionable. Its next
			// heartbeat would fire but no-op, so the indicator must render a dash
			// instead of a misleading "due now".
			const { db } = getTestContext();
			await db.query('UPDATE tasks SET assignee_id = NULL WHERE assignee_id = $1', [agentId]);
		},
	});
	await router.navigate({
		to: '/projects/$projectId/agents/$agentId',
		params: { projectId: teamSlug, agentId },
	});

	const indicator = await findByTestId('next-heartbeat');
	expect(indicator.textContent).toContain('Next heartbeat');
	expect(indicator.textContent).toContain('—');
	expect(indicator.textContent).not.toMatch(/due now|in \d/);
});

test('agent header hides the countdown for a disabled (off-schedule) agent', async () => {
	let teamSlug = '';
	let agentId = '';
	const { queryByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			teamSlug = ws.internalSlug;
			agentId = ws.agents[0].id;
			const { db } = getTestContext();
			await db.query(
				`UPDATE member_agents SET admin_status = 'disabled'::agent_admin_status WHERE id = $1`,
				[agentId],
			);
		},
	});
	await router.navigate({
		to: '/projects/$projectId/agents/$agentId',
		params: { projectId: teamSlug, agentId },
	});

	// Wait for the (disabled) header to render, then assert there's no countdown.
	await waitFor(() => {
		expect(document.querySelector('h1')?.textContent).toMatch(/\(disabled\)/);
	});
	expect(queryByTestId('next-heartbeat')).toBeNull();
});

test('agent disable and enable lifecycle reflects in detail view', async () => {
	let teamSlug = '';
	let teamId = '';
	let agentId = '';

	const { findByRole, getByRole, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			teamSlug = ws.internalSlug;
			teamId = ws.team.id;
			const enabled =
				ws.agents.find((a) => (a as { admin_status?: string }).admin_status === 'enabled') ??
				ws.agents[0];
			agentId = enabled.id;
		},
	});
	await router.navigate({
		to: '/projects/$projectId/agents/$agentId',
		params: { projectId: teamSlug, agentId },
	});

	const main = await findByRole('main');
	const settingsLink = await within(main).findByRole('link', { name: 'Settings' });
	fireEvent.click(settingsLink);

	const disableBtn = await within(getByRole('main')).findByRole('button', {
		name: /Disable agent/i,
	});
	fireEvent.click(disableBtn);
	await waitFor(
		() => {
			expect(document.querySelector('h1')?.textContent).toMatch(/\(disabled\)/);
		},
		{ timeout: 8_000 },
	);

	const enableBtn = await within(getByRole('main')).findByRole('button', {
		name: /Enable agent/i,
	});
	fireEvent.click(enableBtn);

	await waitFor(
		() => {
			expect(document.querySelector('h1')?.textContent).not.toMatch(/\(disabled\)/);
		},
		{ timeout: 8_000 },
	);
	const { apiBase, token } = getTestContext();
	const apiDisable = await apiBase(`/api/projects/${teamSlug}/agents/${agentId}/disable`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}` },
	});
	expect(apiDisable.ok).toBe(true);

	// Force a refetch so the cached agent reflects the just-issued API disable
	// (no realtime socket subscription in the component test harness).
	queryClient.invalidateQueries({ queryKey: ['projects', teamSlug, 'agents', agentId] });

	await router.navigate({
		to: '/projects/$projectId/agents/$agentId',
		params: { projectId: teamSlug, agentId },
	});
	await waitFor(
		() => {
			expect(document.querySelector('h1')?.textContent).toMatch(/\(disabled\)/);
		},
		{ timeout: 10_000 },
	);
});
