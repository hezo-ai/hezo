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

	await findByTestId('project-dashboard', undefined, { timeout: 15_000 });

	// Wait for async widget data to settle.
	await findByTestId('project-dashboard-goals', undefined, { timeout: 15_000 });
	await findByTestId('project-dashboard-progress', undefined, { timeout: 15_000 });

	const dashboard = document.body.querySelector('[data-testid="project-dashboard"]')!;
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

test('widgets render in the default order and the team snapshot reports no container state', async () => {
	const ref = { slug: '' };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Order Demo' });
			ref.slug = project.slug;
			const db = getTestContext().db;
			// The resting state of a pooled project: its last container was parked
			// by the idle-stop cron. Nothing is wrong, so nothing may be flagged.
			await db.query(
				`UPDATE projects SET container_status = 'stopped'::container_status,
				        progress_summary = $1, progress_summary_updated_at = now()
				 WHERE slug = $2`,
				['**Steady.** Work is flowing.', project.slug],
			);
			await db.query(
				`INSERT INTO goals (team_id, project_id, title, measurement, actions, health, progress_percent)
				 SELECT team_id, id, 'Ship it', 'Shipped', 'Build', $1::goal_health, 10
				 FROM projects WHERE slug = $2`,
				[GoalHealth.AtRisk, project.slug],
			);
		},
	});

	await router.navigate({
		to: '/projects/$projectId/dashboard',
		params: { projectId: ref.slug },
	});

	await findByTestId('project-dashboard-goals', undefined, { timeout: 15_000 });

	const dashboard = document.body.querySelector('[data-testid="project-dashboard"]')!;
	const ordered = Array.from(
		dashboard.querySelectorAll(
			'[data-testid="project-dashboard-progress"], [data-testid="project-dashboard-needs-you"], [data-testid="project-dashboard-in-progress"], [data-testid="project-dashboard-team"], [data-testid="project-dashboard-goals"], [data-testid="project-dashboard-spend"]',
		),
	).map((el) => el.getAttribute('data-testid'));
	expect(ordered).toEqual([
		'project-dashboard-progress',
		'project-dashboard-needs-you',
		'project-dashboard-in-progress',
		'project-dashboard-team',
		'project-dashboard-goals',
		'project-dashboard-spend',
	]);

	// A parked container is the ordinary idle state - the snapshot must not
	// report it as a fault (or at all).
	const team = dashboard.querySelector('[data-testid="project-dashboard-team"]')!;
	expect(team.textContent).not.toMatch(/container/i);
});

test('team snapshot links to the running task on slug-based dashboard routes', async () => {
	const ref = { slug: '', taskIdentifier: '' };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Run Link Demo' });
			ref.slug = project.slug;
			const db = getTestContext().db;
			const projectRow = await db.query<{ id: string; team_id: string }>(
				`SELECT id, team_id FROM projects WHERE slug = $1`,
				[project.slug],
			);
			const agentRes = await getTestContext().apiBase(`/api/projects/${project.slug}/agents`, {
				method: 'POST',
				headers: ws.headers,
				body: JSON.stringify({ title: 'Runner' }),
			});
			const agent = (await agentRes.json()).data;

			const taskRes = await getTestContext().apiBase(`/api/projects/${project.slug}/tasks`, {
				method: 'POST',
				headers: ws.headers,
				body: JSON.stringify({
					title: 'Running work',
					assignee_id: agent.id,
				}),
			});
			const task = (await taskRes.json()).data;
			ref.taskIdentifier = task.identifier;
			await db.query(`UPDATE tasks SET status = $1::task_status WHERE id = $2`, [
				TaskStatus.InProgress,
				task.id,
			]);
			await db.query(
				`UPDATE member_agents SET runtime_status = 'active'::agent_runtime_status WHERE id = $1`,
				[agent.id],
			);
			await db.query(
				`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at)
				 VALUES ($1, $2, $3, 'running', now())`,
				[agent.id, projectRow.rows[0].team_id, task.id],
			);
		},
	});

	await router.navigate({
		to: '/projects/$projectId/dashboard',
		params: { projectId: ref.slug },
	});

	await findByTestId('project-dashboard-running-agent', undefined, { timeout: 15_000 });
	const team = document.body.querySelector('[data-testid="project-dashboard-team"]')!;
	const taskLink = Array.from(team.querySelectorAll('a')).find(
		(a) => a.textContent?.trim() === ref.taskIdentifier,
	) as HTMLAnchorElement | undefined;
	expect(taskLink).toBeTruthy();
	expect(taskLink?.textContent).toContain(ref.taskIdentifier);
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

test('project title is the dashboard link and appears above Inbox', async () => {
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

	// The project title link carries this testId and links to /dashboard.
	const dashboardLink = await findByTestId('project-sidebar-dashboard', undefined, {
		timeout: 15_000,
	});
	expect(dashboardLink.getAttribute('href')).toMatch(/\/dashboard$/);

	// The dashboard link must appear before the Inbox link in the DOM.
	const inboxLink = container.querySelector('[data-testid="sidebar-link-inbox"]');
	expect(inboxLink).not.toBeNull();
	const pos = dashboardLink.compareDocumentPosition(inboxLink!);
	// DOCUMENT_POSITION_FOLLOWING (4) means inboxLink comes after dashboardLink.
	expect(pos & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
