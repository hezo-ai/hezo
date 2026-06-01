import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import {
	type SeededProject,
	type SeededTask,
	type SeededWorkspace,
	seedProject,
	seedTask,
	seedWorkspace,
} from './helpers/seed';

async function markMentionRead(mentionId: string): Promise<void> {
	const { db } = getTestContext();
	await db.query('UPDATE board_mentions SET read_at = now() WHERE id = $1', [mentionId]);
}

async function markMentionArchived(mentionId: string): Promise<void> {
	const { db } = getTestContext();
	await db.query(
		'UPDATE board_mentions SET read_at = COALESCE(read_at, now()), archived_at = now() WHERE id = $1',
		[mentionId],
	);
}

async function seedAgentBoardMention(
	workspace: SeededWorkspace,
	task: SeededTask,
	text: string,
): Promise<{ commentId: string; mentionId: string }> {
	const { db } = getTestContext();

	const architect = workspace.agents.find((a) => a.slug === 'architect');
	if (!architect) throw new Error('seedAgentBoardMention: architect agent missing');

	const userRow = await db.query<{ user_id: string }>(
		`SELECT mu.user_id FROM member_users mu
		 JOIN members m ON m.id = mu.id
		 WHERE m.team_id = $1 AND mu.role = 'board'
		 LIMIT 1`,
		[workspace.team.id],
	);
	const userId = userRow.rows[0]?.user_id;
	if (!userId) throw new Error('seedAgentBoardMention: no board user on team');

	const commentRow = await db.query<{ id: string }>(
		`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
		 VALUES ($1, $2, 'text'::comment_content_type, $3::jsonb)
		 RETURNING id`,
		[task.id, architect.id, JSON.stringify({ text })],
	);
	const commentId = commentRow.rows[0].id;

	const mentionRow = await db.query<{ id: string }>(
		`INSERT INTO board_mentions (team_id, task_id, comment_id, user_id)
		 VALUES ($1, $2, $3, $4)
		 RETURNING id`,
		[workspace.team.id, task.id, commentId, userId],
	);

	return { commentId, mentionId: mentionRow.rows[0].id };
}

test('inbox renders a board mention card with author + snippet', async () => {
	let ctx: { teamSlug: string; taskIdentifier: string };
	const { findByTestId, findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Demo' });
			const task = await seedTask(ws, project, { title: 'A board-decision ticket' });
			await seedAgentBoardMention(ws, task, '@board — should we ship the new auth flow?');
			ctx = { teamSlug: ws.team.slug, taskIdentifier: task.identifier };
		},
	});

	await router.navigate({
		to: '/teams/$teamId/inbox',
		params: { teamId: ctx!.teamSlug },
	});

	await findByTestId('mention-card', undefined, { timeout: 10_000 });
	await findByText(/@architect/);
	await findByText(/asked you on/);
	await findByText(ctx!.taskIdentifier);
	await findByText(/should we ship the new auth flow/);
});

test('clicking a mention navigates to the task and marks it read', async () => {
	let ctx: {
		teamSlug: string;
		taskId: string;
		taskIdentifier: string;
		projectSlug: string;
		mentionId: string;
	};
	const helpers = await renderApp({
		initialPath: '/',
		seed: async (testCtx) => {
			const ws = await seedWorkspace();
			const project: SeededProject = await seedProject(ws, { name: 'Demo' });
			const task = await seedTask(ws, project, { title: 'Click-to-read ticket' });
			const { mentionId } = await seedAgentBoardMention(ws, task, '@board please weigh in here.');
			ctx = {
				teamSlug: ws.team.slug,
				taskId: task.id,
				taskIdentifier: task.identifier,
				projectSlug: project.slug,
				mentionId,
			};
			testCtx; // satisfy lint
		},
	});

	await helpers.router.navigate({
		to: '/teams/$teamId/inbox',
		params: { teamId: ctx!.teamSlug },
	});

	const card = await helpers.findByTestId('mention-card', undefined, { timeout: 10_000 });
	await helpers.user.click(card);

	// Component test runs against an in-memory router; the navigate call from the
	// click should have routed to the task page. The router may redirect to the
	// project-scoped task URL — that's fine, we just want to confirm it landed on
	// a task page for the right identifier.
	await new Promise((r) => setTimeout(r, 0));
	const path = helpers.router.state.location.pathname;
	expect(path.startsWith(`/teams/${ctx!.teamSlug}/`)).toBe(true);
	expect(path).toContain('/tasks/');
	expect(path.toLowerCase()).toContain(ctx!.taskIdentifier.toLowerCase());

	// Mark-as-read mutation fires optimistically and persists via the server.
	const { db } = getTestContext();
	const read = await db.query<{ read_at: string | null }>(
		'SELECT read_at FROM board_mentions WHERE id = $1',
		[ctx!.mentionId],
	);
	// Allow the mutation to land — retry a few times so the test isn't racy.
	let updated = read.rows[0]?.read_at;
	for (let i = 0; i < 20 && !updated; i++) {
		await new Promise((r) => setTimeout(r, 25));
		const again = await db.query<{ read_at: string | null }>(
			'SELECT read_at FROM board_mentions WHERE id = $1',
			[ctx!.mentionId],
		);
		updated = again.rows[0]?.read_at;
	}
	expect(updated).not.toBeNull();
});

test('inbox shows read mentions as history and highlights unread ones', async () => {
	let ctx: { teamSlug: string };
	const { findAllByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Demo' });
			const unreadTask = await seedTask(ws, project, { title: 'Unread ticket' });
			const readTask = await seedTask(ws, project, { title: 'Read ticket' });
			await seedAgentBoardMention(ws, unreadTask, '@board fresh decision needed.');
			const { mentionId } = await seedAgentBoardMention(ws, readTask, '@board already handled.');
			await markMentionRead(mentionId);
			ctx = { teamSlug: ws.team.slug };
		},
	});

	await router.navigate({
		to: '/teams/$teamId/inbox',
		params: { teamId: ctx!.teamSlug },
	});

	await waitFor(async () => expect((await findAllByTestId('mention-card')).length).toBe(2), {
		timeout: 10_000,
	});
	const cards = await findAllByTestId('mention-card');
	const flags = cards.map((c) => c.getAttribute('data-unread')).sort();
	expect(flags).toEqual(['false', 'true']);
});

test('read/unread filter and keyword search narrow the inbox', async () => {
	let ctx: { teamSlug: string };
	const { findAllByTestId, findByText, findByLabelText, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Demo' });
			const unreadTask = await seedTask(ws, project, { title: 'Apple ticket' });
			const readTask = await seedTask(ws, project, { title: 'Banana ticket' });
			await seedAgentBoardMention(ws, unreadTask, '@board apple decision.');
			const { mentionId } = await seedAgentBoardMention(ws, readTask, '@board banana decision.');
			await markMentionRead(mentionId);
			ctx = { teamSlug: ws.team.slug };
		},
	});

	await router.navigate({
		to: '/teams/$teamId/inbox',
		params: { teamId: ctx!.teamSlug },
	});

	await waitFor(async () => expect((await findAllByTestId('mention-card')).length).toBe(2), {
		timeout: 10_000,
	});

	// Unread filter keeps only the unread card.
	await user.click(await findByText('Unread'));
	await waitFor(async () => {
		const cards = await findAllByTestId('mention-card');
		expect(cards.length).toBe(1);
		expect(cards[0].getAttribute('data-unread')).toBe('true');
	});

	// Read filter keeps only the read card.
	await user.click(await findByText('Read'));
	await waitFor(async () => {
		const cards = await findAllByTestId('mention-card');
		expect(cards.length).toBe(1);
		expect(cards[0].getAttribute('data-unread')).toBe('false');
	});

	// Back to all, then keyword search narrows to the matching ticket.
	await user.click(await findByText('All'));
	await waitFor(async () => expect((await findAllByTestId('mention-card')).length).toBe(2));
	const searchBox = await findByLabelText('Search inbox');
	await user.type(searchBox, 'banana');
	await waitFor(async () => {
		const cards = await findAllByTestId('mention-card');
		expect(cards.length).toBe(1);
		expect(cards[0].getAttribute('data-unread')).toBe('false');
	});
});

test('archived mentions are hidden by default and shown under the Archived filter', async () => {
	let ctx: { teamSlug: string };
	const { findAllByTestId, findByText, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Demo' });
			const activeTask = await seedTask(ws, project, { title: 'Active ticket' });
			const archivedTask = await seedTask(ws, project, { title: 'Archived ticket' });
			const active = await seedAgentBoardMention(ws, activeTask, '@board active decision.');
			await markMentionRead(active.mentionId);
			const archived = await seedAgentBoardMention(ws, archivedTask, '@board old decision.');
			await markMentionArchived(archived.mentionId);
			ctx = { teamSlug: ws.team.slug };
		},
	});

	await router.navigate({
		to: '/teams/$teamId/inbox',
		params: { teamId: ctx!.teamSlug },
	});

	// Default view shows only the active (non-archived) mention.
	await findByText(/active decision/, undefined, { timeout: 10_000 });
	await waitFor(async () => expect((await findAllByTestId('mention-card')).length).toBe(1));

	// The Archived filter reveals the archived mention and hides the active one.
	await user.click(await findByText('Archived'));
	await findByText(/old decision/, undefined, { timeout: 10_000 });
	await waitFor(async () => expect((await findAllByTestId('mention-card')).length).toBe(1));
});

test('sidebar inbox link shows the unread count badge', async () => {
	let ctx: { teamSlug: string };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Demo' });
			const t1 = await seedTask(ws, project, { title: 'Decision one' });
			const t2 = await seedTask(ws, project, { title: 'Decision two' });
			await seedAgentBoardMention(ws, t1, '@board decision one.');
			await seedAgentBoardMention(ws, t2, '@board decision two.');
			ctx = { teamSlug: ws.team.slug };
		},
	});

	await router.navigate({
		to: '/teams/$teamId/projects',
		params: { teamId: ctx!.teamSlug },
	});

	const link = await findByTestId('sidebar-link-inbox', undefined, { timeout: 10_000 });
	await waitFor(() => expect(link.textContent).toContain('2'));
});
