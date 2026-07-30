import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedProject, seedTask, seedWorkspace } from './helpers/seed';

test('task sidebar lists a queued agent and cancels it via the confirm dialog', async () => {
	const seeded = { projectSlug: '', taskId: '', wakeupId: '', queuedAgentTitle: '' };

	const { findByTestId, findByText, getByTestId, queryByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async (ctx) => {
			const ws = await seedWorkspace();
			const captain = ws.agents.find((a) => a.slug === 'captain') ?? ws.agents[0];
			// Queue a *different* agent than the assignee so the inserted wakeup is
			// unambiguous regardless of any auto 'assignment' wakeup.
			const queuedAgent = ws.agents.find((a) => a.id !== captain.id) ?? ws.agents[0];
			const project = await seedProject(ws, { name: 'Queued Demo' });
			const task = await seedTask(ws, project, { title: 'Queued Task', assignee_id: captain.id });

			const r = await ctx.db.query<{ id: string }>(
				`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload)
				 VALUES ($1, $2, 'mention'::wakeup_source, 'queued'::wakeup_status,
				         jsonb_build_object('task_id', $3::text))
				 RETURNING id`,
				[queuedAgent.id, ws.team.id, task.id],
			);

			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
			seeded.wakeupId = r.rows[0].id;
			seeded.queuedAgentTitle = queuedAgent.title;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	// The queued-agents list renders in the sidebar with the queued agent's name.
	const list = await findByTestId('queued-agents-list', undefined, { timeout: 15_000 });
	expect(list.textContent).toContain(seeded.queuedAgentTitle);

	// Open the confirm dialog and cancel.
	const cancelBtn = await findByTestId(`cancel-queued-wakeup-${seeded.wakeupId}`);
	await user.click(cancelBtn);

	const dialog = await findByText('Cancel queued agent?');
	expect(dialog).toBeTruthy();

	const confirm = getByTestId('confirm-dialog-confirm');
	await user.click(confirm);

	// The real backend cancels the wakeup; the mutation's invalidation forces an
	// immediate refetch, so the row disappears.
	await waitFor(
		() => {
			expect(queryByTestId(`queued-agent-${seeded.wakeupId}`)).toBeNull();
		},
		{ timeout: 15_000 },
	);
});

test('runs a queued agent immediately via the play button', async () => {
	const seeded = { projectSlug: '', taskId: '', wakeupId: '' };

	const { findByTestId, queryByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async (ctx) => {
			const ws = await seedWorkspace();
			const captain = ws.agents.find((a) => a.slug === 'captain') ?? ws.agents[0];
			const queuedAgent = ws.agents.find((a) => a.id !== captain.id) ?? ws.agents[0];
			const project = await seedProject(ws, { name: 'Run Now Demo' });
			const task = await seedTask(ws, project, { title: 'Run Now Task', assignee_id: captain.id });

			const r = await ctx.db.query<{ id: string }>(
				`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload)
				 VALUES ($1, $2, 'mention'::wakeup_source, 'queued'::wakeup_status,
				         jsonb_build_object('task_id', $3::text))
				 RETURNING id`,
				[queuedAgent.id, ws.team.id, task.id],
			);

			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
			seeded.wakeupId = r.rows[0].id;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	const playBtn = (await findByTestId(`run-queued-wakeup-${seeded.wakeupId}`, undefined, {
		timeout: 15_000,
	})) as HTMLButtonElement;
	// Nothing else is running, so the button is actionable.
	expect(playBtn.getAttribute('aria-disabled')).toBeNull();
	expect(playBtn.disabled).toBe(false);

	await user.click(playBtn);

	// The real backend claims the wakeup out of the queue; the mutation's
	// invalidation refetches and the row leaves the "Queued to run" list.
	await waitFor(
		() => {
			expect(queryByTestId(`queued-agent-${seeded.wakeupId}`)).toBeNull();
		},
		{ timeout: 15_000 },
	);
});

test('disables run-now with a capacity reason when the project is at its run limit', async () => {
	const seeded = { projectSlug: '', taskId: '', wakeupId: '' };

	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async (ctx) => {
			const ws = await seedWorkspace();
			const captain = ws.agents.find((a) => a.slug === 'captain') ?? ws.agents[0];
			const queuedAgent = ws.agents.find((a) => a.id !== captain.id) ?? ws.agents[0];
			const project = await seedProject(ws, { name: 'At Capacity Demo' });
			// Container semantics: cap the instance at one active container, park
			// this project's container, and let a filler project's running
			// container hold the only slot.
			await ctx.db.query(
				`INSERT INTO system_meta (key, value) VALUES ('max_active_containers', '1')
				 ON CONFLICT (key) DO UPDATE SET value = '1'`,
			);
			await ctx.db.query(`UPDATE projects SET container_status = 'stopped' WHERE id = $1`, [
				project.id,
			]);
			const filler = await ctx.db.query<{ id: string }>(
				`INSERT INTO teams (name, slug) VALUES ('cap-filler-web', 'cap-filler-web') RETURNING id`,
			);
			await ctx.db.query(
				`INSERT INTO projects (team_id, name, slug, task_prefix, container_id, container_status, container_last_started_at)
				 VALUES ($1, 'cap-filler-web', 'cap-filler-web', 'CFW', 'cid-filler', 'running', now())`,
				[filler.rows[0].id],
			);

			const task = await seedTask(ws, project, { title: 'Waiting Task', assignee_id: captain.id });
			const r = await ctx.db.query<{ id: string }>(
				`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload)
				 VALUES ($1, $2, 'mention'::wakeup_source, 'queued'::wakeup_status,
				         jsonb_build_object('task_id', $3::text))
				 RETURNING id`,
				[queuedAgent.id, ws.team.id, task.id],
			);

			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
			seeded.wakeupId = r.rows[0].id;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	const playBtn = (await findByTestId(`run-queued-wakeup-${seeded.wakeupId}`, undefined, {
		timeout: 15_000,
	})) as HTMLButtonElement;
	await waitFor(() => {
		expect(playBtn.getAttribute('aria-disabled')).toBe('true');
	});
	expect(playBtn.getAttribute('aria-label')).toMatch(/active-container limit/i);
});

test('disables run-now when the queued agent is already running on another task in the project', async () => {
	const seeded = { projectSlug: '', taskId: '', wakeupId: '' };

	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async (ctx) => {
			const ws = await seedWorkspace();
			const captain = ws.agents.find((a) => a.slug === 'captain') ?? ws.agents[0];
			const queuedAgent = ws.agents.find((a) => a.id !== captain.id) ?? ws.agents[0];
			const project = await seedProject(ws, { name: 'Agent Busy Demo' });
			// Plenty of container capacity, so the only blocker is the agent's own slot.

			// The queued agent is already running on a sibling task in this project.
			const sibling = await seedTask(ws, project, { title: 'Occupying Agent Slot' });
			await ctx.db.query(
				`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at)
				 VALUES ($1, $2, $3, 'running'::heartbeat_run_status, now())`,
				[queuedAgent.id, ws.team.id, sibling.id],
			);

			const task = await seedTask(ws, project, { title: 'Waiting Task', assignee_id: captain.id });
			const r = await ctx.db.query<{ id: string }>(
				`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload)
				 VALUES ($1, $2, 'mention'::wakeup_source, 'queued'::wakeup_status,
				         jsonb_build_object('task_id', $3::text))
				 RETURNING id`,
				[queuedAgent.id, ws.team.id, task.id],
			);

			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
			seeded.wakeupId = r.rows[0].id;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	const playBtn = (await findByTestId(`run-queued-wakeup-${seeded.wakeupId}`, undefined, {
		timeout: 15_000,
	})) as HTMLButtonElement;
	await waitFor(() => {
		expect(playBtn.getAttribute('aria-disabled')).toBe('true');
	});
	expect(playBtn.getAttribute('aria-label')).toMatch(/another task in this project/i);
});

test('disables the play button with a reason when the ticket already has a run', async () => {
	const seeded = { projectSlug: '', taskId: '', wakeupId: '' };

	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async (ctx) => {
			const ws = await seedWorkspace();
			const captain = ws.agents.find((a) => a.slug === 'captain') ?? ws.agents[0];
			const queuedAgent = ws.agents.find((a) => a.id !== captain.id) ?? ws.agents[0];
			const project = await seedProject(ws, { name: 'Busy Demo' });
			const task = await seedTask(ws, project, { title: 'Busy Task', assignee_id: captain.id });

			// An active run on this ticket makes it busy → run-now must be disabled.
			await ctx.db.query(
				`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at)
				 VALUES ($1, $2, $3, 'running'::heartbeat_run_status, now())`,
				[captain.id, ws.team.id, task.id],
			);
			const r = await ctx.db.query<{ id: string }>(
				`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload)
				 VALUES ($1, $2, 'mention'::wakeup_source, 'queued'::wakeup_status,
				         jsonb_build_object('task_id', $3::text))
				 RETURNING id`,
				[queuedAgent.id, ws.team.id, task.id],
			);

			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
			seeded.wakeupId = r.rows[0].id;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	const playBtn = (await findByTestId(`run-queued-wakeup-${seeded.wakeupId}`, undefined, {
		timeout: 15_000,
	})) as HTMLButtonElement;
	// aria-disabled (not the native disabled attr) keeps the tooltip reachable;
	// the same reason string feeds both the tooltip and the aria-label.
	await waitFor(() => {
		expect(playBtn.getAttribute('aria-disabled')).toBe('true');
	});
	expect(playBtn.getAttribute('aria-label')).toMatch(/in progress/i);
});
