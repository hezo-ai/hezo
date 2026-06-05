import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { type SeededWorkspace, seedProject, seedTask, seedWorkspace } from './helpers/seed';

async function createApproval(
	workspace: SeededWorkspace,
	body: { type: string; payload: Record<string, unknown> },
) {
	const { apiBase } = getTestContext();
	const res = await apiBase(`/api/teams/${workspace.team.id}/approvals`, {
		method: 'POST',
		headers: workspace.headers,
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`createApproval failed: ${res.status} ${await res.text()}`);
	return ((await res.json()) as { data: { id: string } }).data;
}

test('banner surfaces pending approvals on the task list and links to the inbox', async () => {
	const seeded = { teamSlug: '' };
	const { findByTestId, router, user } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Demo' });
			await seedTask(ws, project, { title: 'Demo Task' });
			await createApproval(ws, { type: 'strategy', payload: { plan: 'Launch' } });
			await createApproval(ws, { type: 'secret_access', payload: { secret_name: 'DB_PASSWORD' } });
			seeded.teamSlug = ws.team.slug;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/tasks',
		params: { teamId: seeded.teamSlug },
	});

	const banner = await findByTestId('admin-approvals-banner', undefined, { timeout: 10_000 });
	expect(banner.textContent).toContain('2 approvals need your review');
	expect(banner.getAttribute('href')).toContain(`/teams/${seeded.teamSlug}/inbox`);

	await user.click(banner);

	await waitFor(() => {
		expect(router.state.location.pathname).toBe(`/teams/${seeded.teamSlug}/inbox`);
	});
});

test('banner is hidden when there are no pending approvals or unread mentions', async () => {
	const seeded = { teamSlug: '' };
	const { findByTestId, queryByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Demo' });
			await seedTask(ws, project, { title: 'Demo Task' });
			seeded.teamSlug = ws.team.slug;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/tasks',
		params: { teamId: seeded.teamSlug },
	});

	// Wait for the list to render, then assert the banner never appears.
	await findByTestId('task-filter-bar', undefined, { timeout: 10_000 });
	await waitFor(() => {
		expect(queryByTestId('admin-approvals-banner')).toBeNull();
	});
});
