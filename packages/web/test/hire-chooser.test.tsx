import { createTestProject, createTestTeam } from '@hezo/server/test/helpers/app';
import { queryClient } from '@hezo/web/lib/query-client';
import { queryKeys } from '@hezo/web/lib/query-keys';
import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';

/**
 * A Blank team (Captain only) rather than `seedWorkspace`'s ten-agent App Team:
 * these specs only need a project whose team page renders.
 */
async function seedBlankProject(): Promise<{ slug: string; name: string }> {
	const { db } = getTestContext();
	const team = (await (await createTestTeam(db, { name: 'Demo Team' })).json()).data;
	const project = (await (await createTestProject(db, team.id, { name: 'Storefront' })).json())
		.data;
	return { slug: project.slug, name: project.name };
}

test('Hire agent opens the chooser instead of dropping straight into the form', async () => {
	let project = { slug: '', name: '' };
	const { findByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			project = await seedBlankProject();
		},
	});
	await router.navigate({
		to: '/projects/$projectId/agents',
		params: { projectId: project.slug },
	});

	await user.click(await findByTestId('hire-agent'));

	// Portalled onto document.body, carrying all three ways to hire.
	await waitFor(() => {
		expect(document.body.querySelector('[data-testid="hire-chooser"]')).toBeTruthy();
	});
	for (const option of ['marketplace', 'ceo', 'manual']) {
		expect(document.body.querySelector(`[data-testid="hire-option-${option}"]`)).toBeTruthy();
	}
	// Naming the project it is hiring for, since the same dialog serves every project.
	expect(document.body.querySelector('[data-testid="hire-chooser"]')?.textContent).toContain(
		'Storefront',
	);
	// Picking nothing has not navigated anywhere.
	expect(router.state.location.pathname).toBe(`/projects/${project.slug}/agents`);
});

test('"Write the role yourself" opens the form, whose back link returns to the chooser', async () => {
	let project = { slug: '', name: '' };
	const { findByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			project = await seedBlankProject();
		},
	});
	await router.navigate({
		to: '/projects/$projectId/agents',
		params: { projectId: project.slug },
	});

	await user.click(await findByTestId('hire-agent'));
	await waitFor(() => {
		expect(document.body.querySelector('[data-testid="hire-option-manual"]')).toBeTruthy();
	});
	await user.click(document.body.querySelector('[data-testid="hire-option-manual"]') as Element);

	await waitFor(() => {
		expect(router.state.location.pathname).toBe(`/projects/${project.slug}/agents/hire`);
	});

	// Back to the fork rather than to the team page: a wrong turn costs one click.
	await user.click(await findByTestId('hire-back-to-chooser'));
	await waitFor(() => {
		expect(router.state.location.pathname).toBe(`/projects/${project.slug}/agents`);
	});
	// `?hire` is what reopens it, so the operator lands back on the three options.
	await waitFor(() => {
		expect(document.body.querySelector('[data-testid="hire-chooser"]')).toBeTruthy();
	});
});

test('"Browse the marketplace" carries the project into the catalog', async () => {
	let project = { slug: '', name: '' };
	const { findByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			project = await seedBlankProject();
		},
	});
	await router.navigate({
		to: '/projects/$projectId/agents',
		params: { projectId: project.slug },
	});

	await user.click(await findByTestId('hire-agent'));
	await waitFor(() => {
		expect(document.body.querySelector('[data-testid="hire-option-marketplace"]')).toBeTruthy();
	});
	await user.click(
		document.body.querySelector('[data-testid="hire-option-marketplace"]') as Element,
	);

	await waitFor(() => {
		expect(router.state.location.pathname).toBe('/marketplace');
	});
	expect((router.state.location.search as { forProject?: string }).forProject).toBe(project.slug);

	// The catalog says what it is mid-way through, so "Add to a project" reads as
	// the continuation of a decision rather than a fresh one.
	const banner = await findByTestId('hiring-for-banner');
	expect(banner.textContent).toContain('Storefront');

	// And the project rides along to the team detail page.
	const card = await findByTestId('marketplace-card-software-development');
	expect(card.getAttribute('href')).toContain(`forProject=${project.slug}`);
});

test('HQ is not staffed from the web app', async () => {
	const { findByTestId, queryByTestId, router } = await renderApp({ initialPath: '/' });
	await router.navigate({ to: '/projects/$projectId/agents', params: { projectId: 'hq' } });

	// The page renders (Export team is always offered) but hiring is not on it:
	// HQ holds the CEO and Coach singletons and is not a team you staff.
	await findByTestId('export-team-button');
	expect(queryByTestId('hire-agent')).toBeNull();

	// Deep-linking past the missing button lands on the same answer.
	await router.navigate({ to: '/projects/$projectId/agents/hire', params: { projectId: 'hq' } });
	await findByTestId('hire-unavailable');
});

test('"Ask the CEO" opens a new thread with the message written but not sent', async () => {
	let project = { slug: '', name: '' };
	const created: Array<{ title?: string }> = [];
	let sends = 0;
	const THREAD_ID = 'hire-thread-1';

	// The component harness runs no ChatSessionManager, so the chat endpoints 503.
	// Answer just the thread-creation call and seed the history cache the widget
	// reads (staleTime Infinity, so a seeded thread never refetches).
	const passthrough = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
		if (method === 'POST' && url.includes('/api/chat/messages')) sends += 1;
		if (method === 'POST' && url.includes('/api/chat/conversations')) {
			created.push(JSON.parse(String(init?.body ?? '{}')));
			return new Response(
				JSON.stringify({
					data: {
						conversation: {
							id: THREAD_ID,
							channel: 'web',
							external_thread_id: null,
							kind: 'assistant',
							title: 'Hire for Storefront',
							last_activity_at: new Date().toISOString(),
							closed_at: null,
						},
					},
				}),
				{ status: 201, headers: { 'Content-Type': 'application/json' } },
			);
		}
		return passthrough(input as RequestInfo, init);
	}) as typeof globalThis.fetch;

	try {
		const { findByTestId, user, router } = await renderApp({
			initialPath: '/',
			seed: async () => {
				project = await seedBlankProject();
				queryClient.setQueryData(queryKeys.chatConversations(), {
					conversations: [
						{
							id: THREAD_ID,
							channel: 'web',
							external_thread_id: null,
							kind: 'assistant',
							title: 'Hire for Storefront',
							last_activity_at: new Date().toISOString(),
							closed_at: null,
						},
					],
				});
				queryClient.setQueryData(queryKeys.chatConversation(THREAD_ID), {
					conversation_id: THREAD_ID,
					messages: [],
					compacted_count: 0,
				});
			},
		});
		await router.navigate({
			to: '/projects/$projectId/agents',
			params: { projectId: project.slug },
		});

		await user.click(await findByTestId('hire-agent'));
		await user.click(await findByTestId('hire-option-ceo'));

		// The thread is named for the project, since the CEO chat is global and has
		// no per-project scope of its own.
		await waitFor(() => expect(created.length).toBe(1));
		expect(created[0].title).toBe('Hire for Storefront');

		// The chat opens on that thread with the opening line written for the
		// operator - and deliberately NOT sent, so they can say what they actually
		// need before the CEO has to ask.
		await findByTestId('chat-panel');
		const input = (await findByTestId('chat-input')) as HTMLTextAreaElement;
		await waitFor(() => {
			expect(input.value).toContain('add an agent to the Storefront project');
		});
		const select = (await findByTestId('chat-thread-select')) as HTMLSelectElement;
		expect(select.value).toBe(THREAD_ID);

		// Nothing was posted: the draft is the operator's to send. This is the whole
		// point of prefilling rather than auto-sending, so it is the assertion that
		// would catch a regression to sending on open.
		expect(sends).toBe(0);
	} finally {
		globalThis.fetch = passthrough;
	}
});
