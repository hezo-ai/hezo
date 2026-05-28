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
