import { GoalHealth, HQ_PROJECT_SLUG, TaskStatus } from '@hezo/shared';
import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { seedProject, seedWorkspace } from './helpers/seed';

/** Insert a goal straight onto a project, bypassing the approval flow the API requires. */
async function seedGoalRow(
	projectSlug: string,
	title: string,
	health: GoalHealth,
	percent: number,
) {
	await getTestContext().db.query(
		`INSERT INTO goals (team_id, project_id, title, measurement, actions, health, progress_percent)
		 SELECT team_id, id, $1, 'Measured', 'Build', $2::goal_health, $3
		 FROM projects WHERE slug = $4`,
		[title, health, percent, projectSlug],
	);
}

/** Create a task through the API and force it into a non-default status. */
async function seedTaskWithStatus(
	projectSlug: string,
	headers: HeadersInit,
	title: string,
	status: TaskStatus,
	assigneeId?: string,
) {
	const res = await getTestContext().apiBase(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers,
		body: JSON.stringify({ title, ...(assigneeId ? { assignee_id: assigneeId } : {}) }),
	});
	const body = await res.json();
	if (!body.data) throw new Error(`seedTaskWithStatus failed: ${JSON.stringify(body)}`);
	const task = body.data;
	await getTestContext().db.query(`UPDATE tasks SET status = $1::task_status WHERE id = $2`, [
		status,
		task.id,
	]);
	return task;
}

test('the dashboard carries the summary, metrics, goals, spend and in-progress work', async () => {
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
			await seedTaskWithStatus(
				project.slug,
				ws.headers,
				'Active work',
				TaskStatus.InProgress,
				agent.id,
			);
			await seedGoalRow(project.slug, 'Hit launch date', GoalHealth.AtRisk, 55);
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
	await findByTestId('dashboard-goals', undefined, { timeout: 15_000 });
	await findByTestId('dashboard-spend', undefined, { timeout: 15_000 });

	const dashboard = document.body.querySelector('[data-testid="project-dashboard"]')!;
	expect(dashboard.textContent).toContain('Dash View');
	expect(dashboard.textContent).toContain('Shipping');
	expect(dashboard.textContent).toContain('Hit launch date');
	expect(dashboard.textContent).toContain('Active work');
	await waitFor(() => expect(dashboard.textContent).toContain('$9.99'));

	const taskRow = dashboard.querySelector(
		'[data-testid="dashboard-task-row"]',
	) as HTMLAnchorElement | null;
	expect(taskRow).toBeTruthy();
	// Task links use the human identifier, never the UUID.
	expect(taskRow!.getAttribute('href')).toMatch(/\/tasks\/[a-z0-9]+-\d+$/i);
});

test('the page bands run metrics, summary, live agents, then the two columns', async () => {
	const ref = { slug: '' };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Order Demo' });
			ref.slug = project.slug;
			await getTestContext().db.query(
				`UPDATE projects SET progress_summary = $1, progress_summary_updated_at = now()
				 WHERE slug = $2`,
				['**Steady.** Work is flowing.', project.slug],
			);
			await seedGoalRow(project.slug, 'Ship it', GoalHealth.AtRisk, 10);
		},
	});

	await router.navigate({
		to: '/projects/$projectId/dashboard',
		params: { projectId: ref.slug },
	});

	await findByTestId('dashboard-goals', undefined, { timeout: 15_000 });

	const dashboard = document.body.querySelector('[data-testid="project-dashboard"]')!;
	const ordered = Array.from(
		dashboard.querySelectorAll(
			[
				'[data-testid="dashboard-metrics"]',
				'[data-testid="project-progress-summary"]',
				'[data-testid="dashboard-active-agents"]',
				'[data-testid="dashboard-action-items"]',
				'[data-testid="dashboard-in-progress"]',
				'[data-testid="dashboard-goals"]',
				'[data-testid="dashboard-spend"]',
				'[data-testid="progress-updates"]',
			].join(', '),
		),
	).map((el) => el.getAttribute('data-testid'));
	expect(ordered).toEqual([
		'dashboard-metrics',
		'project-progress-summary',
		'dashboard-active-agents',
		'dashboard-action-items',
		'dashboard-in-progress',
		'dashboard-goals',
		'dashboard-spend',
		'progress-updates',
	]);
});

test('the goals card caps its slots, ranks worst health first, and links to the rest', async () => {
	const ref = { slug: '' };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Many Goals' });
			ref.slug = project.slug;
			// Six goals against four slots, seeded healthiest-first so ordering cannot pass by
			// accident: the card must surface the off-track and at-risk ones instead.
			await seedGoalRow(project.slug, 'Healthy one', GoalHealth.OnTrack, 90);
			await seedGoalRow(project.slug, 'Healthy two', GoalHealth.OnTrack, 80);
			await seedGoalRow(project.slug, 'Healthy three', GoalHealth.OnTrack, 70);
			await seedGoalRow(project.slug, 'Unassessed one', GoalHealth.Pending, 0);
			await seedGoalRow(project.slug, 'Wobbling', GoalHealth.AtRisk, 40);
			await seedGoalRow(project.slug, 'Slipping', GoalHealth.OffTrack, 15);
		},
	});

	await router.navigate({
		to: '/projects/$projectId/dashboard',
		params: { projectId: ref.slug },
	});

	await findByTestId('dashboard-goals', undefined, { timeout: 15_000 });
	const card = document.body.querySelector('[data-testid="dashboard-goals"]')!;

	// Four slots, one of which is spent on the overflow link, so three goals render.
	const slots = Array.from(card.querySelectorAll('[data-testid="dashboard-goal-slot"]'));
	expect(slots).toHaveLength(3);
	expect(slots.map((s) => s.textContent)).toEqual([
		expect.stringContaining('Slipping'),
		expect.stringContaining('Wobbling'),
		expect.stringContaining('Unassessed one'),
	]);

	const more = card.querySelector('[data-testid="dashboard-goals-more"]') as HTMLAnchorElement;
	expect(more).toBeTruthy();
	expect(more.textContent).toContain('3 more goals');
	expect(more.getAttribute('href')).toBe(`/projects/${ref.slug}/goals`);
});

test('a project sitting on the cap renders every goal and no overflow row', async () => {
	const ref = { slug: '' };
	const { findByTestId, queryByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Exactly Four' });
			ref.slug = project.slug;
			for (const [i, title] of ['One', 'Two', 'Three', 'Four'].entries()) {
				await seedGoalRow(project.slug, title, GoalHealth.OnTrack, i * 10);
			}
		},
	});

	await router.navigate({
		to: '/projects/$projectId/dashboard',
		params: { projectId: ref.slug },
	});

	await findByTestId('dashboard-goals', undefined, { timeout: 15_000 });
	const card = document.body.querySelector('[data-testid="dashboard-goals"]')!;
	expect(card.querySelectorAll('[data-testid="dashboard-goal-slot"]')).toHaveLength(4);
	expect(queryByTestId('dashboard-goals-more')).toBeNull();
});

test('the goals card invites a first goal when the project has none', async () => {
	const ref = { slug: '' };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'No Goals' });
			ref.slug = project.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/dashboard',
		params: { projectId: ref.slug },
	});

	const empty = await findByTestId('dashboard-goals-empty', undefined, { timeout: 15_000 });
	expect(empty.textContent).toContain('No goals yet');
	const cta = empty.querySelector('a') as HTMLAnchorElement;
	expect(cta.getAttribute('href')).toBe(`/projects/${ref.slug}/goals`);
});

test('the in-progress list caps its rows and offers the full list when there are more', async () => {
	const ref = { slug: '' };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Busy Project' });
			ref.slug = project.slug;
			// Eight in-flight tasks against a cap of seven.
			for (let i = 1; i <= 8; i++) {
				await seedTaskWithStatus(
					project.slug,
					ws.headers,
					`Work item ${i}`,
					TaskStatus.InProgress,
					ws.agents[0].id,
				);
			}
		},
	});

	await router.navigate({
		to: '/projects/$projectId/dashboard',
		params: { projectId: ref.slug },
	});

	await findByTestId('dashboard-in-progress', undefined, { timeout: 15_000 });
	const list = document.body.querySelector('[data-testid="dashboard-in-progress"]')!;
	await waitFor(() =>
		expect(list.querySelectorAll('[data-testid="dashboard-task-row"]')).toHaveLength(7),
	);
	const more = list.querySelector(
		'[data-testid="dashboard-in-progress-more"]',
	) as HTMLAnchorElement;
	expect(more).toBeTruthy();
	expect(more.getAttribute('href')).toBe(`/projects/${ref.slug}/tasks`);
});

test('the active-agents strip names who is working and links the task', async () => {
	const ref = { slug: '', taskIdentifier: '' };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Run Link Demo' });
			ref.slug = project.slug;
			const db = getTestContext().db;
			const projectRow = await db.query<{ team_id: string }>(
				`SELECT team_id FROM projects WHERE slug = $1`,
				[project.slug],
			);
			const agentRes = await getTestContext().apiBase(`/api/projects/${project.slug}/agents`, {
				method: 'POST',
				headers: ws.headers,
				body: JSON.stringify({ title: 'Runner' }),
			});
			const agent = (await agentRes.json()).data;

			const task = await seedTaskWithStatus(
				project.slug,
				ws.headers,
				'Running work',
				TaskStatus.InProgress,
				agent.id,
			);
			ref.taskIdentifier = task.identifier;
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

	await findByTestId('dashboard-active-agent', undefined, { timeout: 15_000 });
	const strip = document.body.querySelector('[data-testid="dashboard-active-agents"]')!;
	expect(strip.textContent).toContain('Working now');
	const taskLink = Array.from(strip.querySelectorAll('a')).find(
		(a) => a.textContent?.trim() === ref.taskIdentifier,
	) as HTMLAnchorElement | undefined;
	expect(taskLink).toBeTruthy();
	expect(taskLink?.getAttribute('href')).toContain(
		`/projects/${ref.slug}/tasks/${ref.taskIdentifier.toLowerCase()}`,
	);
});

test('the active-agents strip stays present, and idle, when nothing is running', async () => {
	const ref = { slug: '' };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Quiet Project' });
			ref.slug = project.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/dashboard',
		params: { projectId: ref.slug },
	});

	// The strip is the one band that must not disappear when empty: agents work in bursts, so
	// a collapsing card would shift the page every time a run started or finished.
	const idle = await findByTestId('dashboard-active-agents-idle', undefined, { timeout: 15_000 });
	expect(idle.textContent).toContain('No agents running');
});

test('HQ drops the summary, goals and spend, and shows the empty HQ state', async () => {
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
	expect(queryByTestId('dashboard-spend')).toBeNull();
	expect(queryByTestId('dashboard-goals')).toBeNull();
	expect(queryByTestId('project-progress-summary')).toBeNull();
	// The heartbeat history belongs to the summary it produces, so it goes with it.
	expect(queryByTestId('progress-updates')).toBeNull();
	expect(dashboard.textContent).toContain('HQ is ready');
	// Action items, tasks and the agent strip still apply to HQ.
	expect(queryByTestId('dashboard-action-items')).not.toBeNull();
	expect(queryByTestId('dashboard-active-agents')).not.toBeNull();
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
