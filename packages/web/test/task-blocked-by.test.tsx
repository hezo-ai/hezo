import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { seedProject, seedTask, seedWorkspace } from './helpers/seed';

test('Blocked By row links to the blocking task', async () => {
	let ctx: {
		projectSlug: string;
		blockerIdentifier: string;
		blockedIdentifier: string;
	};
	const { findByRole, findByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async ({ apiBase }) => {
			const ws = await seedWorkspace();
			const engineer = ws.agents.find((a) => a.slug === 'engineer') ?? ws.agents[0];
			const project = await seedProject(ws, { name: 'Blocking Project' });
			const blocker = await seedTask(ws, project, {
				title: 'Upstream blocker',
				assignee_id: engineer.id,
			});
			const blocked = await seedTask(ws, project, {
				title: 'Downstream blocked',
				assignee_id: engineer.id,
			});
			const dep = await apiBase(
				`/api/projects/${ws.internalSlug}/tasks/${blocked.id}/dependencies`,
				{
					method: 'POST',
					headers: ws.headers,
					body: JSON.stringify({ blocked_by_task_id: blocker.id }),
				},
			);
			if (!dep.ok) throw new Error(`dependency seed failed: ${dep.status}`);

			ctx = {
				projectSlug: project.slug,
				blockerIdentifier: blocker.identifier,
				blockedIdentifier: blocked.identifier,
			};
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: {
			projectId: ctx!.projectSlug,
			taskId: ctx!.blockedIdentifier.toLowerCase(),
		},
	});

	await findByRole('heading', { name: 'Downstream blocked' });

	const row = await findByTestId('blocked-by-item');
	expect(row.textContent).toContain(ctx!.blockerIdentifier);
	expect(row.textContent).toContain('Upstream blocker');

	await user.click(row);
	await findByRole('heading', { name: 'Upstream blocker' });
	expect(router.state.location.pathname).toBe(
		`/projects/${ctx!.projectSlug}/tasks/${ctx!.blockerIdentifier.toLowerCase()}`,
	);
});

test('Blocked By row shows the running dot when the blocker has an active run', async () => {
	let ctx: { projectSlug: string; blockedIdentifier: string };
	const { findByRole, findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async ({ apiBase }) => {
			const ws = await seedWorkspace();
			const engineer = ws.agents.find((a) => a.slug === 'engineer') ?? ws.agents[0];
			const project = await seedProject(ws, { name: 'Blocking Project' });
			const blocker = await seedTask(ws, project, {
				title: 'Upstream blocker',
				assignee_id: engineer.id,
			});
			const blocked = await seedTask(ws, project, {
				title: 'Downstream blocked',
				assignee_id: engineer.id,
			});
			const dep = await apiBase(
				`/api/projects/${ws.internalSlug}/tasks/${blocked.id}/dependencies`,
				{
					method: 'POST',
					headers: ws.headers,
					body: JSON.stringify({ blocked_by_task_id: blocker.id }),
				},
			);
			if (!dep.ok) throw new Error(`dependency seed failed: ${dep.status}`);

			// Put an in-flight run on the blocker so its dependency row lights up.
			await getTestContext().db.query(
				`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status)
				 VALUES ($1, $2, $3, 'running')`,
				[ws.team.id, engineer.id, blocker.id],
			);

			ctx = { projectSlug: project.slug, blockedIdentifier: blocked.identifier };
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: {
			projectId: ctx!.projectSlug,
			taskId: ctx!.blockedIdentifier.toLowerCase(),
		},
	});

	await findByRole('heading', { name: 'Downstream blocked' });

	const row = await findByTestId('blocked-by-item');
	await waitFor(() => {
		expect(row.querySelector('[data-testid="task-running-dot"]')).not.toBeNull();
	});
});
