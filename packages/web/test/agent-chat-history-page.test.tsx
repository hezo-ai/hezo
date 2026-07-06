// Coverage for routes/projects/$projectId/agents/$agentId/chat-history.tsx: the
// long-term chat-memory editor. Chat memory exists only for chat-enabled agents
// (those with a ceo_conversations row — today the CEO), so the specs enable chat
// on a workspace agent directly in the DB and drive the page against the real
// GET/PUT /chat-memory routes.

import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { type SeededWorkspace, seedWorkspace } from './helpers/seed';

/** Make an agent chat-enabled (conversation row) with optional stored memory. */
async function enableChatMemory(
	ws: SeededWorkspace,
	agentId: string,
	content?: string,
): Promise<void> {
	const { db } = getTestContext();
	await db.query(`INSERT INTO ceo_conversations (member_id, team_id) VALUES ($1, $2)`, [
		agentId,
		ws.team.id,
	]);
	if (content !== undefined) {
		await db.query(`INSERT INTO chat_memories (member_id, content) VALUES ($1, $2)`, [
			agentId,
			content,
		]);
	}
}

test('an agent without chat memory shows the unavailable notice', async () => {
	const seeded = { slug: '', agentId: '' };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			seeded.slug = ws.internalSlug;
			seeded.agentId = ws.agents[0].id;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/agents/$agentId/chat-history',
		params: { projectId: seeded.slug, agentId: seeded.agentId },
	});

	const notice = await findByTestId('chat-history-unavailable', undefined, { timeout: 15_000 });
	expect(notice.textContent).toContain('This agent has no chat history.');
});

test('stored memory loads into the editor with its updated timestamp; edits save through the API', async () => {
	const seeded = { slug: '', agentId: '' };
	const { findByLabelText, findByTestId, getByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			await enableChatMemory(ws, ws.agents[0].id, 'Operator prefers concise updates.');
			seeded.slug = ws.internalSlug;
			seeded.agentId = ws.agents[0].id;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/agents/$agentId/chat-history',
		params: { projectId: seeded.slug, agentId: seeded.agentId },
	});

	// The stored memory seeds the editor once loaded.
	const editor = (await findByLabelText('Long-term chat memory', undefined, {
		timeout: 15_000,
	})) as HTMLTextAreaElement;
	await waitFor(() => expect(editor.value).toBe('Operator prefers concise updates.'));

	// The header shows when the memory was last written (formatUpdated output —
	// e.g. "Updated Jul 6, 10:00 AM" — always starts with "Updated" + month).
	const updated = await findByTestId('chat-history-updated');
	expect(updated.textContent).toMatch(/^Updated \w{3} \d/);

	// Pristine editor → Save disabled.
	const save = getByTestId('chat-history-save') as HTMLButtonElement;
	expect(save.disabled).toBe(true);

	// Editing makes it dirty and enables Save.
	await user.type(editor, ' Timezone is UTC.');
	expect(save.disabled).toBe(false);

	await user.click(save);
	// Response-driven: once the server echoes the stored value, the editor is
	// clean again and Save re-disables.
	await waitFor(() =>
		expect((getByTestId('chat-history-save') as HTMLButtonElement).disabled).toBe(true),
	);

	// The edit actually persisted server-side.
	const { apiBase, token } = getTestContext();
	const res = await apiBase(`/api/projects/${seeded.slug}/agents/${seeded.agentId}/chat-memory`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const body = (await res.json()) as { data: { content: string } };
	expect(body.data.content).toBe('Operator prefers concise updates. Timezone is UTC.');
});

test('a failed save surfaces the server error inline', async () => {
	const seeded = { slug: '', agentId: '' };
	const { findByLabelText, findByTestId, getByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			await enableChatMemory(ws, ws.agents[0].id, 'Existing memory.');
			seeded.slug = ws.internalSlug;
			seeded.agentId = ws.agents[0].id;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/agents/$agentId/chat-history',
		params: { projectId: seeded.slug, agentId: seeded.agentId },
	});

	const editor = (await findByLabelText('Long-term chat memory', undefined, {
		timeout: 15_000,
	})) as HTMLTextAreaElement;
	await waitFor(() => expect(editor.value).toBe('Existing memory.'));

	// Fail the PUT underneath the page; everything else passes through.
	const passthrough = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url =
			typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
		const method = (input instanceof Request ? input.method : init?.method) ?? 'GET';
		if (method === 'PUT' && url.includes('/chat-memory')) {
			return new Response(
				JSON.stringify({ error: { code: 'BOOM', message: 'memory store unavailable' } }),
				{ status: 500, headers: { 'Content-Type': 'application/json' } },
			);
		}
		return passthrough(input as RequestInfo, init);
	}) as typeof globalThis.fetch;

	await user.type(editor, ' More.');
	await user.click(getByTestId('chat-history-save'));

	const err = await findByTestId('chat-history-error');
	expect(err.textContent).toBe('memory store unavailable');
});

test('the help dialog explains compaction into long-term memory', async () => {
	const seeded = { slug: '', agentId: '' };
	const { findByLabelText, findByRole, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			await enableChatMemory(ws, ws.agents[0].id, '');
			seeded.slug = ws.internalSlug;
			seeded.agentId = ws.agents[0].id;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/agents/$agentId/chat-history',
		params: { projectId: seeded.slug, agentId: seeded.agentId },
	});

	await findByLabelText('Long-term chat memory', undefined, { timeout: 15_000 });
	await user.click(await findByRole('button', { name: 'How chat history works' }));

	// Radix dialog renders into a portal on document.body.
	await waitFor(() => {
		expect(document.body.textContent).toContain('How chat history works');
		expect(document.body.textContent).toContain('long-term memory');
		expect(document.body.textContent).toContain('maintained automatically');
	});
});
