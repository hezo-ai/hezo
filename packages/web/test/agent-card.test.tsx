import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { agentChatRoom } from '../src/hooks/use-chat';
import { currentRoomValue } from './helpers/chat-switcher';
import { renderApp } from './helpers/render';
import { seedComment, seedProject, seedTask, seedWorkspace } from './helpers/seed';

// The agent card: a linked agent name opens a small card - the agent's identity,
// a link to its page and a chat shortcut - instead of navigating. Popovers,
// navigation and the chat dock are all observable in happy-dom, so this stays a
// component test; the phone layout is covered in `agent-card.mobile.spec.ts`.

interface SeededAgent {
	id: string;
	slug: string;
	title: string;
	is_instance?: boolean;
}

/** A task with one comment authored by the agent `pick` chooses. */
async function renderAgentComment(pick: (agents: SeededAgent[]) => SeededAgent | undefined) {
	const seeded = { projectSlug: '', taskId: '', agent: undefined as SeededAgent | undefined };
	const app = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Agent Card Project' });
			const task = await seedTask(ws, project, { title: 'Agent Card Task' });
			const agent = pick(ws.agents as SeededAgent[]);
			if (!agent) throw new Error('agent-card test: agent not seeded');
			await seedComment(ws, task, 'Written by the agent', { authorMemberId: agent.id });
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
			seeded.agent = agent;
		},
	});
	await app.router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});
	await app.findByText('Written by the agent', undefined, { timeout: 15_000 });
	const agent = seeded.agent;
	if (!agent) throw new Error('agent-card test: agent not seeded');
	return { ...app, projectSlug: seeded.projectSlug, taskId: seeded.taskId, agent };
}

const projectAgent = (agents: SeededAgent[]) => agents.find((a) => !a.is_instance);

test('clicking an agent name opens the card and stays on the page', async () => {
	const { findByTestId, user, router, projectSlug, taskId, agent } =
		await renderAgentComment(projectAgent);
	const taskPath = `/projects/${projectSlug}/tasks/${taskId}`;

	const name = await findByTestId('comment-author');
	// Still a real link, so a modified click can open the page in a new tab.
	expect(name.getAttribute('href')).toBe(`/projects/${projectSlug}/agents/${agent.slug}`);
	expect(name.getAttribute('aria-expanded')).toBe('false');

	await user.click(name);

	const card = await findByTestId('agent-card');
	expect(router.state.location.pathname).toBe(taskPath);
	expect(name.getAttribute('aria-expanded')).toBe('true');
	expect(card.textContent).toContain(agent.title);
	expect((await findByTestId('agent-card-page-link')).getAttribute('href')).toBe(
		`/projects/${projectSlug}/agents/${agent.slug}`,
	);
	expect((await findByTestId('agent-card-chat')).textContent).toBe(`Chat with ${agent.title}`);

	// A second click on the name closes it again.
	await user.click(name);
	await waitFor(() => expect(document.querySelector('[data-testid="agent-card"]')).toBeNull());
});

test("the card's chat link opens the dock on that agent's chat", async () => {
	const { findByTestId, queryByTestId, user, router, projectSlug, taskId, agent } =
		await renderAgentComment(projectAgent);

	await user.click(await findByTestId('comment-author'));
	await user.click(await findByTestId('agent-card-chat'));

	await findByTestId('chat-panel');
	expect(currentRoomValue()).toBe(`agent:${agent.slug}`);
	expect(router.state.location.pathname).toBe(`/projects/${projectSlug}/tasks/${taskId}`);
	await waitFor(() => expect(queryByTestId('agent-card')).toBeNull());
});

test("the card's page link goes to the agent page", async () => {
	const { findByTestId, user, router, projectSlug, agent } = await renderAgentComment(projectAgent);

	await user.click(await findByTestId('comment-author-avatar-link'));
	await user.click(await findByTestId('agent-card-page-link'));

	await waitFor(() =>
		expect(router.state.location.pathname).toBe(`/projects/${projectSlug}/agents/${agent.slug}`),
	);
});

test('the Coach card links to its HQ page and offers no chat', async () => {
	const { findByTestId, queryByTestId, user } = await renderAgentComment((agents) =>
		agents.find((a) => a.slug === 'coach'),
	);

	await user.click(await findByTestId('comment-author'));

	await findByTestId('agent-card');
	expect((await findByTestId('agent-card-page-link')).getAttribute('href')).toBe(
		'/projects/hq/agents/coach',
	);
	expect(queryByTestId('agent-card-chat')).toBeNull();
});

test('resting the mouse on a name opens the card, and leaving closes it', async () => {
	const { findByTestId, queryByTestId, user } = await renderAgentComment(projectAgent);
	const name = await findByTestId('comment-author');

	await user.hover(name);
	await findByTestId('agent-card');

	await user.unhover(name);
	await waitFor(() => expect(queryByTestId('agent-card')).toBeNull());
});

test('a card opened by a click stays open when the mouse leaves', async () => {
	const { findByTestId, queryByTestId, user } = await renderAgentComment(projectAgent);
	const name = await findByTestId('comment-author');

	await user.hover(name);
	await user.click(name);
	await findByTestId('agent-card');
	await user.unhover(name);
	// Longer than the close delay: a pinned card ignores the pointer leaving.
	await new Promise((r) => setTimeout(r, 400));
	expect(queryByTestId('agent-card')).not.toBeNull();

	await user.keyboard('{Escape}');
	await waitFor(() => expect(queryByTestId('agent-card')).toBeNull());
});

test('a name inside a task list row opens the card, not the task', async () => {
	const seeded = { projectSlug: '', agentSlug: '' };
	const { findByTestId, findByText, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Agent Card List Project' });
			const agent = projectAgent(ws.agents as SeededAgent[]);
			if (!agent) throw new Error('agent-card test: no project agent seeded');
			await seedTask(ws, project, { title: 'Agent Card Row', assignee_id: agent.id });
			seeded.projectSlug = project.slug;
			seeded.agentSlug = agent.slug;
		},
	});
	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: seeded.projectSlug },
	});
	const listPath = router.state.location.pathname;

	// The project's own planning task has an assignee too: take the name in our row.
	const row = (await findByText('Agent Card Row', undefined, { timeout: 15_000 })).closest('tr');
	const name = row?.querySelector('[data-testid="task-list-assignee"]');
	if (!name) throw new Error('agent-card test: assignee name not in the task row');
	await user.click(name);

	await findByTestId('agent-card');
	expect(router.state.location.pathname).toBe(listPath);

	// The card's own clicks must not reach the row either.
	await user.click(await findByTestId('agent-card-page-link'));
	await waitFor(() =>
		expect(router.state.location.pathname).toBe(
			`/projects/${seeded.projectSlug}/agents/${seeded.agentSlug}`,
		),
	);
});

test("a mention's card fills in the agent's live status from the roster", async () => {
	// A mention carries only the name and role baked into the text; the card
	// reads the rest from the live roster once it opens.
	const seeded = { projectSlug: '', taskId: '' };
	const { findByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Agent Card Mention Project' });
			const task = await seedTask(ws, project, { title: 'Agent Card Mention Task' });
			const agent = projectAgent(ws.agents as SeededAgent[]);
			if (!agent) throw new Error('agent-card test: no project agent seeded');
			await seedComment(ws, task, `@${agent.slug} please look`);
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
		},
	});
	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	await user.click(await findByTestId('agent-mention-link', undefined, { timeout: 15_000 }));

	expect((await findByTestId('agent-card-status')).textContent).toBe('Idle');
});

test('agentChatRoom: the CEO opens the CEO stream, the Coach has none, a project agent its DM', () => {
	expect(agentChatRoom({ slug: 'ceo', is_instance: true }, 'demo', 'uuid-1')).toEqual({
		kind: 'ceo',
	});
	// Inferred from the slug when the instance flag is missing.
	expect(agentChatRoom({ slug: 'coach' }, 'demo', 'uuid-1')).toBeNull();
	expect(agentChatRoom({ slug: 'architect', title: 'Architect' }, 'demo', 'uuid-1')).toEqual({
		kind: 'agent',
		projectSlug: 'demo',
		projectUuid: 'uuid-1',
		agentSlug: 'architect',
		title: 'Architect',
	});
	// The project index has not loaded yet.
	expect(agentChatRoom({ slug: 'architect' }, 'demo', undefined)).toBeNull();
});
