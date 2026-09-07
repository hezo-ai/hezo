import type { ChatMessage } from '@hezo/web/hooks/use-chat';
import { queryClient } from '@hezo/web/lib/query-client';
import { queryKeys } from '@hezo/web/lib/query-keys';
import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedWorkspace } from './helpers/seed';

// Per-project agent DMs, web side: the project menu's chat launcher cards, the
// dock switcher's project section, and the agent-suggested quick-reply chips.
// The roster/DM list rides the real GET /api/projects/:slug/chat/conversations
// route (the harness runs the full backend); message history for the CEO room
// is seeded straight into the query cache as in chat-threads.test.tsx.

const now = () => new Date().toISOString();

function msg(id: string, content: string, role: ChatMessage['role'] = 'assistant'): ChatMessage {
	return { id, role, channel: 'web', status: 'complete', content, created_at: now() };
}

test('the project menu lists a chat card per roster agent and opens the dock on that DM', async () => {
	let projectSlug = '';
	let agent = { slug: '', title: '' };
	const { findByTestId, findAllByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			projectSlug = ws.internalSlug;
			agent = ws.agents[0];
		},
	});
	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: projectSlug },
	});

	// One card per enabled roster agent (the server list; CEO/Coach are HQ
	// members and never appear here).
	await findByTestId('project-sidebar-chat');
	const card = await findByTestId(`chat-card-${agent.slug}`);
	expect(card.textContent).toContain(agent.title);

	// Clicking a card opens the dock on that agent's DM - no navigation.
	await user.click(card);
	await findByTestId('chat-panel');
	const select = (await findByTestId('chat-room-select')) as HTMLSelectElement;
	expect(select.value).toBe(`agent:${agent.slug}`);
	expect((await findByTestId('chat-room-title')).textContent).toBe(agent.title);
	// The composer addresses the agent by name; the empty state introduces the DM.
	const input = (await findByTestId('chat-input')) as HTMLTextAreaElement;
	expect(input.placeholder).toBe(`Message ${agent.title}…`);
	expect(router.state.location.pathname).toBe(`/projects/${projectSlug}/tasks`);
	// All cards rendered (sanity: the whole roster is DM-able).
	const cards = await findAllByTestId(/^chat-card-/);
	expect(cards.length).toBeGreaterThan(1);
});

test('the dock switcher groups the current project DMs under the project name', async () => {
	let projectSlug = '';
	let agentCount = 0;
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			projectSlug = ws.internalSlug;
			// Only the team's own roster is DM-able: the agents API also returns the
			// HQ singletons (CEO/Coach) as virtual members, which the DM list excludes.
			agentCount = (ws.agents as Array<{ is_instance?: boolean }>).filter(
				(a) => !a.is_instance,
			).length;
		},
	});
	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: projectSlug },
	});

	(await findByTestId('app-header-chat')).click();
	const select = (await findByTestId('chat-room-select')) as HTMLSelectElement;
	// Pinned CEO first, then the project's DM optgroup with the full roster.
	expect(select.options[0].value).toBe('ceo');
	await waitFor(() => {
		const group = Array.from(select.querySelectorAll('optgroup')).find(
			(g) => g.label === 'Demo Project',
		);
		expect(group).toBeTruthy();
		expect(group?.querySelectorAll('option').length).toBe(agentCount);
	});
});

test('suggested replies render as chips; a click sends the literal text as the operator', async () => {
	queryClient.setQueryData(queryKeys.chatConversation(), {
		conversation_id: 'convo-1',
		messages: [
			msg('u1', 'Should we ship it?', 'user'),
			{ ...msg('a1', 'Ready to go. Ship now?'), suggested_replies: ['Yes, ship it', 'Hold off'] },
		],
		compacted_count: 0,
	});

	// Intercept the send so the assertion is on what a chip click posts.
	const sent: Array<{ messages: Array<{ text: string }> }> = [];
	const passthrough = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
		if (method === 'POST' && url.includes('/api/chat/messages')) {
			sent.push(JSON.parse(String(init?.body ?? '{}')));
			return new Response(JSON.stringify({ data: { ok: true } }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}
		return passthrough(input as RequestInfo, init);
	}) as typeof globalThis.fetch;

	try {
		const { findByTestId, findAllByTestId, user } = await renderApp({
			initialPath: '/home',
		});
		(await findByTestId('app-header-chat')).click();
		await findByTestId('chat-panel');

		// Chips render under the latest assistant reply, carrying the literal texts.
		const chips = await findAllByTestId('chat-suggested-reply');
		expect(chips.map((c) => c.textContent)).toEqual(['Yes, ship it', 'Hold off']);

		// A click sends exactly that text as a normal user message (chips carry no
		// actions). Clearing-on-reply rides the real turn (the next assistant tail
		// has no suggestions); clearing-on-typing is asserted in the next test.
		await user.click(chips[0]);
		await waitFor(() => expect(sent.length).toBe(1));
		expect(sent[0].messages.map((m) => m.text)).toEqual(['Yes, ship it']);
	} finally {
		globalThis.fetch = passthrough;
	}
});

test('suggested replies clear the moment the operator starts typing', async () => {
	queryClient.setQueryData(queryKeys.chatConversation(), {
		conversation_id: 'convo-1',
		messages: [{ ...msg('a1', 'Pick one.'), suggested_replies: ['Option A', 'Option B'] }],
		compacted_count: 0,
	});

	const { findByTestId, findAllByTestId, queryByTestId, user } = await renderApp({
		initialPath: '/home',
	});
	(await findByTestId('app-header-chat')).click();
	await findByTestId('chat-panel');

	expect((await findAllByTestId('chat-suggested-reply')).length).toBe(2);
	await user.type((await findByTestId('chat-input')) as HTMLTextAreaElement, 'actually, neither');
	await waitFor(() => expect(queryByTestId('chat-suggested-replies')).toBeNull());
});
