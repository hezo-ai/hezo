import { queryClient } from '@hezo/web/lib/query-client';
import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { seedWorkspace } from './helpers/seed';

// Group rooms, web side: the built-in General room's card and dock room, the
// create-room dialog, the untagged-message nudge, and message-level convert.
// The harness runs the full backend (real routes, real manager over the stub
// engine); WS is stubbed, so live re-renders are observed via the store and a
// forced refetch, as chat.test.tsx documents.

test('the built-in General room is provisioned, carded, and opens in the dock', async () => {
	let projectSlug = '';
	const { findByTestId, findAllByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			projectSlug = ws.internalSlug;
		},
	});
	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: projectSlug },
	});

	// The list read lazily provisions General, so the menu grows a group card
	// without anyone creating a room.
	await findByTestId('project-sidebar-chat');
	const groupCards = await findAllByTestId(/^chat-card-group-/);
	expect(groupCards.length).toBe(1);
	expect(groupCards[0].textContent).toContain('General');

	// Clicking the card opens the dock on the room - no navigation.
	await user.click(groupCards[0]);
	await findByTestId('chat-panel');
	const select = (await findByTestId('chat-room-select')) as HTMLSelectElement;
	await waitFor(() => expect(select.value).toMatch(/^group:/));
	expect((await findByTestId('chat-room-title')).textContent).toBe('General');
	const input = (await findByTestId('chat-input')) as HTMLTextAreaElement;
	expect(input.placeholder).toContain('Message the room');

	// The switcher carries the Rooms optgroup with the General room in it.
	await waitFor(() => {
		const rooms = Array.from(select.querySelectorAll('optgroup')).find((g) => g.label === 'Rooms');
		expect(rooms).toBeTruthy();
		expect(rooms?.querySelectorAll('option').length).toBe(1);
	});
	expect(router.state.location.pathname).toBe(`/projects/${projectSlug}/tasks`);
});

test('the create-room dialog makes a room and lands the dock in it', async () => {
	let projectSlug = '';
	const { findByTestId, findAllByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			projectSlug = ws.internalSlug;
		},
	});
	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: projectSlug },
	});

	(await findByTestId('app-header-chat')).click();
	await findByTestId('chat-panel');
	(await findByTestId('chat-new-group')).click();
	await findByTestId('chat-create-group-dialog');

	await user.type(
		(await findByTestId('chat-create-group-name')) as HTMLInputElement,
		'Launch crew',
	);
	const participants = await findAllByTestId('chat-create-group-participant');
	await user.click(participants[0]);
	await user.click(await findByTestId('chat-create-group-submit'));

	// Response-driven: the dock switches to the room the server created.
	await waitFor(async () => {
		const select = (await findByTestId('chat-room-select')) as HTMLSelectElement;
		expect(select.value).toMatch(/^group:/);
	});
	expect((await findByTestId('chat-room-title')).textContent).toBe('Launch crew');
});

test('an untagged first message draws the local nudge, and converts into a task', async () => {
	let projectSlug = '';
	const { findByTestId, findAllByTestId, getByText, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			projectSlug = ws.internalSlug;
		},
	});
	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: projectSlug },
	});

	await findByTestId('project-sidebar-chat');
	const groupCards = await findAllByTestId(/^chat-card-group-/);
	await user.click(groupCards[0]);
	const input = (await findByTestId('chat-input')) as HTMLTextAreaElement;
	await user.type(input, 'hello everyone');
	await user.click(await findByTestId('chat-send'));

	// No mention, no locus: nobody replies, and the local nudge says why.
	await findByTestId('chat-group-nudge');

	// The stored row replaces the optimistic bubble on a refetch (WS is stubbed).
	await waitFor(async () => {
		const rows = await getTestContext().db.query(
			`SELECT id FROM chat_messages WHERE content = 'hello everyone'`,
		);
		expect((rows as { rows: unknown[] }).rows.length).toBe(1);
	});
	await queryClient.invalidateQueries({ queryKey: ['projects'] });
	await waitFor(() => expect(getByText('hello everyone')).toBeTruthy());

	// Message-level convert: the dialog seeds the title from the message; the
	// group default assignee is the Captain, so submitting needs nothing else.
	await user.click((await findAllByTestId('chat-message-convert'))[0]);
	await findByTestId('chat-convert-dialog');
	expect(((await findByTestId('chat-convert-title')) as HTMLInputElement).value).toBe(
		'hello everyone',
	);
	await user.click(await findByTestId('chat-convert-submit'));
	await waitFor(async () => {
		const tasks = await getTestContext().db.query(
			`SELECT origin_chat_conversation_id FROM tasks WHERE title = 'hello everyone'`,
		);
		const rows = (tasks as { rows: Array<{ origin_chat_conversation_id: string | null }> }).rows;
		expect(rows.length).toBe(1);
		expect(rows[0].origin_chat_conversation_id).not.toBeNull();
	});
});
