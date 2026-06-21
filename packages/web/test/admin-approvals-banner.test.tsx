import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { type SeededWorkspace, seedProject, seedTask, seedWorkspace } from './helpers/seed';

async function createApproval(
	workspace: SeededWorkspace,
	body: { type: string; payload: Record<string, unknown> },
) {
	const { apiBase } = getTestContext();
	const res = await apiBase(`/api/projects/${workspace.internalSlug}/approvals`, {
		method: 'POST',
		headers: workspace.headers,
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`createApproval failed: ${res.status} ${await res.text()}`);
	return ((await res.json()) as { data: { id: string } }).data;
}

test('banner surfaces pending approvals on the task list and links to the inbox', async () => {
	const seeded = { projectSlug: '' };
	const { findByTestId, router, user } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Demo' });
			await seedTask(ws, project, { title: 'Demo Task' });
			await createApproval(ws, { type: 'strategy', payload: { plan: 'Launch' } });
			await createApproval(ws, { type: 'plan_review', payload: { summary: 'Review' } });
			seeded.projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: seeded.projectSlug },
	});

	const banner = await findByTestId('admin-approvals-banner', undefined, { timeout: 10_000 });
	expect(banner.textContent).toContain('2 approvals need your review');
	expect(banner.getAttribute('href')).toContain(`/projects/${seeded.projectSlug}/inbox`);

	await user.click(banner);

	await waitFor(() => {
		expect(router.state.location.pathname).toBe(`/projects/${seeded.projectSlug}/inbox`);
	});
});

test('banner is hidden when there are no pending approvals or unread mentions', async () => {
	const seeded = { projectSlug: '' };
	const { findByTestId, queryByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Demo' });
			await seedTask(ws, project, { title: 'Demo Task' });
			seeded.projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: seeded.projectSlug },
	});

	// Wait for the list to render, then assert the banner never appears.
	await findByTestId('task-filter-bar', undefined, { timeout: 10_000 });
	await waitFor(() => {
		expect(queryByTestId('admin-approvals-banner')).toBeNull();
	});
});
