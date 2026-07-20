import { GoalHealth, HQ_PROJECT_SLUG, TaskStatus } from '@hezo/shared';
import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { seedProject, seedWorkspace } from './helpers/seed';

test('project dashboard shows spend, progress, goals, and in-progress tasks', async () => {
	const ref = { slug: '' };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Dash View' });
			ref.slug = project.slug;
			const db = getTestContext().db;
			const agent = ws.agents[0];

			await db.query(
				`UPDATE projects SET progress_summary = $1, progress_summary_updated_at = now() WHERE slug = $2`,
				['**Shipping.** Dashboard is live.', project.slug],
			);

			const taskRes = await getTestContext().apiBase(`/api/projects/${project.slug}/tasks`, {
				method: 'POST',
				headers: ws.headers,
				body: JSON.stringify({
					title: 'Active work',
					assignee_id: agent.id,
				}),
			});
			const task = (await taskRes.json()).data;
			await db.query(`UPDATE tasks SET status = $1::task_status WHERE id = $2`, [
				TaskStatus.InProgress,
				task.id,
			]);

			await db.query(
				`INSERT INTO goals (team_id, project_id, title, measurement, actions, health, progress_percent)
				 SELECT team_id, id, 'Hit launch date', 'Shipped', 'Build', $1::goal_health, 55
				 FROM projects WHERE slug = $2`,
				[GoalHealth.AtRisk, project.slug],
			);

			await db.query(
				`INSERT INTO cost_entries (member_id, project_id, amount_cents)
				 SELECT $1, id, 999 FROM projects WHERE slug = $2`,
				[agent.id, project.slug],
			);
		},
	});

	await router.navigate({
		to: '/projects/$projectId/dashboard',
		params: { projectId: ref.slug },
	});

	const dashboard = await findByTestId('project-dashboard', undefined, { timeout: 15_000 });
	expect(dashboard.textContent).toContain('Dash View');
	expect(dashboard.textContent).toContain('$9.99');
	expect(dashboard.textContent).toContain('Shipping');
	expect(dashboard.textContent).toContain('Hit launch date');
	expect(dashboard.textContent).toContain('Active work');

	const taskRow = dashboard.querySelector(
		'[data-testid="project-dashboard-task-row"]',
	) as HTMLAnchorElement | null;
	expect(taskRow).toBeTruthy();
	expect(taskRow!.getAttribute('href')).toMatch(/\/tasks\/[a-z0-9]+-\d+$/i);
	expect(taskRow!.getAttribute('href')).not.toMatch(
		/\/tasks\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
	);
});

test('HQ dashboard hides spend/goals and shows the empty HQ state', async () => {
	const { findByTestId, queryByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			await seedWorkspace();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/dashboard',
		params: { projectId: HQ_PROJECT_SLUG },
	});

	const dashboard = await findByTestId('project-dashboard', undefined, { timeout: 15_000 });
	expect(queryByTestId('project-dashboard-spend')).toBeNull();
	expect(queryByTestId('project-dashboard-goals')).toBeNull();
	expect(queryByTestId('project-dashboard-progress')).toBeNull();
	expect(dashboard.textContent).toContain('HQ is ready');
});

test('project index redirects to dashboard', async () => {
	const ref = { slug: '' };
	const { router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Redirect Demo' });
			ref.slug = project.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId',
		params: { projectId: ref.slug },
	});

	await waitFor(() =>
		expect(router.state.location.pathname).toBe(`/projects/${ref.slug}/dashboard`),
	);
});

test('sidebar lists Dashboard first', async () => {
	let projectSlug = '';
	const { container, findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Nav Demo' });
			projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/dashboard',
		params: { projectId: projectSlug },
	});

	await findByTestId('project-sidebar-dashboard', undefined, { timeout: 15_000 });
	const nav = container.querySelector('nav[aria-label="Sidebar"]');
	if (!nav) throw new Error('sidebar missing');
	const links = Array.from(nav.querySelectorAll('a')).map((a) => a.textContent?.trim());
	const dashboardIdx = links.findIndex((t) => t?.startsWith('Dashboard'));
	const inboxIdx = links.findIndex((t) => t?.startsWith('Inbox'));
	expect(dashboardIdx).toBeGreaterThanOrEqual(0);
	expect(inboxIdx).toBeGreaterThan(dashboardIdx);
});
