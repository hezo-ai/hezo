import { screen, waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { currentRoomValue } from './helpers/chat-switcher';
import { getTestContext, renderApp } from './helpers/render';
import { seedProject, seedWorkspace } from './helpers/seed';

// A team room - an agent DM or a group room - belongs to its project: leaving
// the project closes the dock, whether for another project or a page outside
// any project. The CEO is not project-scoped and stays. happy-dom reports a
// 1024px viewport, so this is the desktop rail, which otherwise survives
// navigation; the mobile sheet closes on every navigation anyway.

interface TwoProjects {
	alpha: string;
	alphaId: string;
	beta: string;
	agent: { slug: string; title: string };
}

/** Lands on Alpha's tasks board - by slug, or by its id alias with `viaId`. */
async function renderTwoProjects({ viaId = false } = {}) {
	const seeded: TwoProjects = { alpha: '', alphaId: '', beta: '', agent: { slug: '', title: '' } };
	const app = await renderApp({
		initialPath: '/',
		seed: async () => {
			const a = await seedWorkspace();
			const b = await seedWorkspace();
			const alpha = await seedProject(a, { name: 'Alpha' });
			seeded.alpha = alpha.slug;
			seeded.alphaId = alpha.id;
			seeded.beta = (await seedProject(b, { name: 'Beta' })).slug;
			seeded.agent = a.agents[0];
		},
	});
	await app.router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: viaId ? seeded.alphaId : seeded.alpha },
	});
	await app.findByTestId('project-sidebar-chat', undefined, { timeout: 15_000 });
	return { ...app, ...seeded };
}

test('switching to another project in the rail closes a group room', async () => {
	const { findAllByTestId, findByTestId, user, beta } = await renderTwoProjects();

	await user.click((await findAllByTestId(/^chat-card-group-/))[0]);
	await findByTestId('chat-panel');
	await waitFor(() => expect(currentRoomValue()).toMatch(/^group:/));

	await user.click(
		await findByTestId(`project-rail-avatar-${beta}`, undefined, { timeout: 15_000 }),
	);

	await waitFor(() => expect(screen.queryByTestId('chat-panel')).toBeNull());
});

test('leaving for a page outside any project closes an agent DM', async () => {
	const { findByTestId, user, router, agent } = await renderTwoProjects();

	await user.click(await findByTestId(`chat-card-${agent.slug}`));
	await findByTestId('chat-panel');
	expect(currentRoomValue()).toBe(`agent:${agent.slug}`);

	await router.navigate({ to: '/settings/containers' });

	await waitFor(() => expect(router.state.location.pathname).toBe('/settings/containers'));
	await waitFor(() => expect(screen.queryByTestId('chat-panel')).toBeNull());
});

test('moving between pages of the same project keeps the agent DM open', async () => {
	const { findByTestId, user, router, alpha, agent } = await renderTwoProjects();

	await user.click(await findByTestId(`chat-card-${agent.slug}`));
	await findByTestId('chat-panel');

	await router.navigate({ to: '/projects/$projectId/dashboard', params: { projectId: alpha } });

	await waitFor(() => expect(router.state.location.pathname).toBe(`/projects/${alpha}/dashboard`));
	expect(screen.getByTestId('chat-panel')).toBeTruthy();
	expect(currentRoomValue()).toBe(`agent:${agent.slug}`);
});

test("a DM opened on the project's id alias stays open on its slug", async () => {
	// The menu launches the room with whatever handle the route carries; the
	// rail links the slug. Same project, so the dock must not read it as a switch.
	const { findByTestId, user, router, alpha, agent } = await renderTwoProjects({ viaId: true });

	await user.click(await findByTestId(`chat-card-${agent.slug}`));
	await findByTestId('chat-panel');

	await user.click(
		await findByTestId(`project-rail-avatar-${alpha}`, undefined, { timeout: 15_000 }),
	);

	await waitFor(() =>
		expect(router.state.location.pathname).toMatch(new RegExp(`^/projects/${alpha}/`)),
	);
	expect(screen.getByTestId('chat-panel')).toBeTruthy();
	expect(currentRoomValue()).toBe(`agent:${agent.slug}`);
});

test('renaming the project keeps its DM open, now sending to the new slug', async () => {
	const {
		findByTestId,
		findByRole,
		findByLabelText,
		getByRole,
		user,
		router,
		alpha,
		alphaId,
		agent,
	} = await renderTwoProjects();

	await user.click(await findByTestId(`chat-card-${agent.slug}`));
	await findByTestId('chat-panel');

	await router.navigate({ to: '/projects/$projectId/settings', params: { projectId: alpha } });
	await user.click(await findByRole('button', { name: 'Edit' }, { timeout: 15_000 }));
	const name = (await findByLabelText('Name')) as HTMLInputElement;
	await user.clear(name);
	await user.type(name, 'Gamma');
	await user.click(getByRole('button', { name: 'Save' }));

	const { db } = getTestContext();
	const renamed = await waitFor(async () => {
		const res = await db.query<{ slug: string }>('SELECT slug FROM projects WHERE id = $1', [
			alphaId,
		]);
		expect(res.rows[0].slug).not.toBe(alpha);
		return res.rows[0].slug;
	});
	await waitFor(() => expect(router.state.location.pathname).toBe(`/projects/${renamed}/settings`));
	expect(screen.getByTestId('chat-panel')).toBeTruthy();
	expect(currentRoomValue()).toBe(`agent:${agent.slug}`);

	// The room follows the project to its new slug: a send addresses it, where
	// the old slug would now 404.
	const sentTo: string[] = [];
	const passthrough = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
		if (method === 'POST' && url.includes('/chat/agents/')) {
			sentTo.push(new URL(url, 'http://x').pathname);
			return new Response(JSON.stringify({ data: {} }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}
		return passthrough(input as RequestInfo, init);
	}) as typeof globalThis.fetch;
	try {
		await user.type(await findByTestId('chat-input'), 'still here?{Enter}');
		await waitFor(() =>
			expect(sentTo).toEqual([`/api/projects/${renamed}/chat/agents/${agent.slug}/messages`]),
		);
	} finally {
		globalThis.fetch = passthrough;
	}
});

test('the CEO stays open across a project switch', async () => {
	const { findByTestId, user, router, beta } = await renderTwoProjects();

	await user.click(await findByTestId('app-header-chat'));
	await findByTestId('chat-panel');
	await waitFor(() => expect(currentRoomValue()).toBe('ceo'));

	await router.navigate({ to: '/projects/$projectId/tasks', params: { projectId: beta } });

	await waitFor(() => expect(router.state.location.pathname).toBe(`/projects/${beta}/tasks`));
	expect(screen.getByTestId('chat-panel')).toBeTruthy();
	expect(currentRoomValue()).toBe('ceo');
});

test('a DM closed by hand, then a project switch, leaves the CEO monogram opening the CEO', async () => {
	// The monogram opens the dock one render before its CEO room lands. A DM
	// left in the closed dock and judged against the new project in that render
	// would shut the dock the operator just opened.
	const { findByTestId, user, router, beta, agent } = await renderTwoProjects();

	await user.click(await findByTestId(`chat-card-${agent.slug}`));
	await findByTestId('chat-panel');
	await user.click(await findByTestId('chat-close'));
	await waitFor(() => expect(screen.queryByTestId('chat-panel')).toBeNull());

	await router.navigate({ to: '/projects/$projectId/tasks', params: { projectId: beta } });
	await waitFor(() => expect(router.state.location.pathname).toBe(`/projects/${beta}/tasks`));

	await user.click(await findByTestId('app-header-chat'));
	await findByTestId('chat-panel');
	await waitFor(() => expect(currentRoomValue()).toBe('ceo'));
	expect(screen.getByTestId('chat-panel')).toBeTruthy();
});
