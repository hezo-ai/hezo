import { render, waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { AgentQueueSection } from '../src/components/task-detail/agent-queue-section';
import { getTestContext, renderApp } from './helpers/render';
import { seedProject, seedRunningAgent, seedTask, seedWorkspace } from './helpers/seed';

test('shows the running agent with a loader and a terminate button', async () => {
	const seeded = { projectSlug: '', taskId: '', agentId: '', agentTitle: '' };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			// Assign to Captain and run a *different* agent so the assignee's own
			// background wakeup can't add a second lock for our subject.
			const captain = ws.agents.find((a) => a.slug === 'captain') ?? ws.agents[0];
			const agent = ws.agents.find((a) => a.id !== captain.id) ?? ws.agents[0];
			const project = await seedProject(ws, { name: 'Running Demo' });
			const task = await seedTask(ws, project, { title: 'Running Task', assignee_id: captain.id });
			await seedRunningAgent(ws, task, agent.id);
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
			seeded.agentId = agent.id;
			seeded.agentTitle = agent.title;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	const section = await findByTestId('agent-queue-section', undefined, { timeout: 15_000 });
	expect(section.textContent).toContain('Agent Queue');

	const row = await findByTestId(`running-agent-${seeded.agentId}`);
	expect(row.textContent).toContain(seeded.agentTitle);
	// The loader animation replaces the queued row's run-now button.
	expect(row.querySelector('.animate-spin')).not.toBeNull();
	// The delete button terminates the run.
	const terminate = await findByTestId(`terminate-running-agent-${seeded.agentId}`);
	expect(terminate).toBeTruthy();
});

test('terminates the running run via the confirm dialog', async () => {
	const seeded = { projectSlug: '', taskId: '', agentId: '', runId: '' };
	const { findByTestId, findByText, getByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const captain = ws.agents.find((a) => a.slug === 'captain') ?? ws.agents[0];
			const agent = ws.agents.find((a) => a.id !== captain.id) ?? ws.agents[0];
			const project = await seedProject(ws, { name: 'Terminate Demo' });
			const task = await seedTask(ws, project, {
				title: 'Terminate Task',
				assignee_id: captain.id,
			});
			const { runId } = await seedRunningAgent(ws, task, agent.id);
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
			seeded.agentId = agent.id;
			seeded.runId = runId;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	const terminate = await findByTestId(`terminate-running-agent-${seeded.agentId}`, undefined, {
		timeout: 15_000,
	});
	await user.click(terminate);

	// Same confirm dialog copy as the run page's Terminate button.
	await findByText('Terminate this run?');
	await user.click(getByTestId('confirm-dialog-confirm'));

	// The run is cancelled server-side through the shared terminate flow.
	await waitFor(
		async () => {
			const r = await getTestContext().db.query<{ status: string }>(
				'SELECT status FROM heartbeat_runs WHERE id = $1',
				[seeded.runId],
			);
			expect(r.rows[0]?.status).toBe('cancelled');
		},
		{ timeout: 15_000 },
	);
});

test('terminates a running agent even before its run comment lands', async () => {
	// The lock surfaces the active run id, so the terminate control is available
	// the moment the agent is `running` — without waiting for the run comment.
	const seeded = { projectSlug: '', taskId: '', agentId: '', runId: '' };
	const { findByTestId, findByText, getByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async (ctx) => {
			const ws = await seedWorkspace();
			const captain = ws.agents.find((a) => a.slug === 'captain') ?? ws.agents[0];
			const agent = ws.agents.find((a) => a.id !== captain.id) ?? ws.agents[0];
			const project = await seedProject(ws, { name: 'No Comment Demo' });
			const task = await seedTask(ws, project, {
				title: 'No Comment Task',
				assignee_id: captain.id,
			});
			// Seed a running heartbeat run + lock, but deliberately NO run comment.
			const runRes = await ctx.db.query<{ id: string }>(
				`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at)
				 VALUES ($1, $2, $3, 'running'::heartbeat_run_status, now())
				 RETURNING id`,
				[agent.id, ws.team.id, task.id],
			);
			await ctx.db.query(
				`INSERT INTO execution_locks (task_id, member_id, lock_type) VALUES ($1, $2, 'read')`,
				[task.id, agent.id],
			);
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
			seeded.agentId = agent.id;
			seeded.runId = runRes.rows[0].id;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	const terminate = await findByTestId(`terminate-running-agent-${seeded.agentId}`, undefined, {
		timeout: 15_000,
	});
	await user.click(terminate);

	await findByText('Terminate this run?');
	await user.click(getByTestId('confirm-dialog-confirm'));

	await waitFor(
		async () => {
			const r = await getTestContext().db.query<{ status: string }>(
				'SELECT status FROM heartbeat_runs WHERE id = $1',
				[seeded.runId],
			);
			expect(r.rows[0]?.status).toBe('cancelled');
		},
		{ timeout: 15_000 },
	);
});

test('lists running agents above queued agents', async () => {
	const seeded = { projectSlug: '', taskId: '', runningAgentId: '', wakeupId: '' };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async (ctx) => {
			const ws = await seedWorkspace();
			const captain = ws.agents.find((a) => a.slug === 'captain') ?? ws.agents[0];
			const nonCaptain = ws.agents.filter((a) => a.id !== captain.id);
			const runningAgent = nonCaptain[0];
			const queuedAgent = nonCaptain[1] ?? nonCaptain[0];
			const project = await seedProject(ws, { name: 'Order Demo' });
			const task = await seedTask(ws, project, { title: 'Order Task', assignee_id: captain.id });
			await seedRunningAgent(ws, task, runningAgent.id);
			const r = await ctx.db.query<{ id: string }>(
				`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload)
				 VALUES ($1, $2, 'mention'::wakeup_source, 'queued'::wakeup_status,
				         jsonb_build_object('task_id', $3::text))
				 RETURNING id`,
				[queuedAgent.id, ws.team.id, task.id],
			);
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
			seeded.runningAgentId = runningAgent.id;
			seeded.wakeupId = r.rows[0].id;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	await findByTestId('agent-queue-section', undefined, { timeout: 15_000 });
	const runningRow = await findByTestId(`running-agent-${seeded.runningAgentId}`);
	const queuedRow = await findByTestId(`queued-agent-${seeded.wakeupId}`);
	// Running rows render before the queued group, so the queued row follows it.
	expect(
		runningRow.compareDocumentPosition(queuedRow) & Node.DOCUMENT_POSITION_FOLLOWING,
	).toBeTruthy();
});

test('renders nothing when the task is fully idle (no running and no queued agents)', () => {
	// Direct render of the gating branch — deterministic, and sidesteps the
	// fire-and-forget assignment wakeup a freshly-created task would post.
	const { container } = render(
		<AgentQueueSection
			projectId="team"
			taskId="task"
			locks={[]}
			comments={[]}
			wakeups={[]}
			dispatch={undefined}
		/>,
	);
	expect(container.firstChild).toBeNull();
});
