import { DEFAULT_HEARTBEAT_INTERVAL_MIN } from '@hezo/shared';
import { fireEvent, waitFor, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { queryClient } from '../src/lib/query-client';
import { getTestContext, renderApp } from './helpers/render';
import { seedWorkspace } from './helpers/seed';

test('team org chart renders with status legend', async () => {
	let teamSlug = '';
	const { findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			teamSlug = ws.internalSlug;
		},
	});
	await router.navigate({ to: '/projects/$projectId/agents', params: { projectId: teamSlug } });
	await findByText('You (Admin)', undefined, { timeout: 15_000 });
	await findByText('Active', undefined, { timeout: 15_000 });
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
		const executionsLink = within(main).getByRole('link', { name: 'Executions' });
		expect(executionsLink.className).toMatch(/border-inverse/);
	});

	const settingsLink = within(getByRole('main')).getByRole('link', { name: 'Settings' });
	expect(settingsLink).toBeTruthy();
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
