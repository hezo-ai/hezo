import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import {
	seedComment,
	seedProject,
	seedRunningAgent,
	seedTask,
	seedWorkspace,
} from './helpers/seed';

// These cover that agent references across the task detail page navigate to the
// agent's profile page (`/projects/$projectId/agents/$agentId`): the assignee
// chip, the comment author avatar + name, and the running / queued rows in the
// Agent Queue. Pure render + href assertions, so a component test fits.

test('assignee chip links to the agent page', async () => {
	const seeded = { projectSlug: '', taskId: '', agentSlug: '' };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Assignee Link Project' });
			const agent = ws.agents[0];
			const task = await seedTask(ws, project, {
				title: 'Assignee Link Task',
				assignee_id: agent.id,
			});
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
			seeded.agentSlug = agent.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	const link = (await findByTestId('task-assignee-link', undefined, {
		timeout: 15_000,
	})) as HTMLAnchorElement;
	expect(link.getAttribute('href')).toBe(
		`/projects/${seeded.projectSlug}/agents/${seeded.agentSlug}`,
	);
});

test('agent comment author avatar and name link to the agent page', async () => {
	const seeded = { projectSlug: '', taskId: '', agentSlug: '' };
	const { findByTestId, findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Author Link Project' });
			const task = await seedTask(ws, project, { title: 'Author Link Task' });
			const agent = ws.agents[0];
			await seedComment(ws, task, 'Authored by the agent', { authorMemberId: agent.id });
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
			seeded.agentSlug = agent.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	await findByText('Authored by the agent', undefined, { timeout: 15_000 });

	const expectedHref = `/projects/${seeded.projectSlug}/agents/${seeded.agentSlug}`;
	const avatarLink = (await findByTestId('comment-author-avatar-link')) as HTMLAnchorElement;
	expect(avatarLink.getAttribute('href')).toBe(expectedHref);
	const nameLink = (await findByTestId('comment-author')) as HTMLAnchorElement;
	expect(nameLink.tagName).toBe('A');
	expect(nameLink.getAttribute('href')).toBe(expectedHref);
});

test('human comment author stays an unlinked label', async () => {
	const seeded = { projectSlug: '', taskId: '' };
	const { findByTestId, findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Human Author Project' });
			const task = await seedTask(ws, project, { title: 'Human Author Task' });
			// seedComment posts via the board token => author_type 'user'.
			await seedComment(ws, task, 'Authored by a human');
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	await findByText('Authored by a human', undefined, { timeout: 15_000 });
	const author = (await findByTestId('comment-author')) as HTMLElement;
	expect(author.tagName).toBe('SPAN');
});

test('running agent in the Agent Queue links to the agent page', async () => {
	const seeded = { projectSlug: '', taskId: '', agentId: '', agentSlug: '' };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			// Assign Captain, run a different agent — mirrors agent-queue.test.tsx so
			// the assignee's own wakeup can't add a second lock for our subject.
			const captain = ws.agents.find((a) => a.slug === 'captain') ?? ws.agents[0];
			const agent = ws.agents.find((a) => a.id !== captain.id) ?? ws.agents[0];
			const project = await seedProject(ws, { name: 'Running Link Project' });
			const task = await seedTask(ws, project, {
				title: 'Running Link Task',
				assignee_id: captain.id,
			});
			await seedRunningAgent(ws, task, agent.id);
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
			seeded.agentId = agent.id;
			seeded.agentSlug = agent.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	const link = (await findByTestId(`running-agent-link-${seeded.agentId}`, undefined, {
		timeout: 15_000,
	})) as HTMLAnchorElement;
	expect(link.getAttribute('href')).toBe(
		`/projects/${seeded.projectSlug}/agents/${seeded.agentSlug}`,
	);
});

test('queued agent in the Agent Queue links to the agent page', async () => {
	const seeded = { projectSlug: '', taskId: '', wakeupId: '', agentSlug: '' };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async (ctx) => {
			const ws = await seedWorkspace();
			const captain = ws.agents.find((a) => a.slug === 'captain') ?? ws.agents[0];
			const queuedAgent = ws.agents.find((a) => a.id !== captain.id) ?? ws.agents[0];
			const project = await seedProject(ws, { name: 'Queued Link Project' });
			const task = await seedTask(ws, project, {
				title: 'Queued Link Task',
				assignee_id: captain.id,
			});
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
			seeded.agentSlug = queuedAgent.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	const link = (await findByTestId(`queued-agent-link-${seeded.wakeupId}`, undefined, {
		timeout: 15_000,
	})) as HTMLAnchorElement;
	expect(link.getAttribute('href')).toBe(
		`/projects/${seeded.projectSlug}/agents/${seeded.agentSlug}`,
	);
});
