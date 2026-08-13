import { TaskView } from '@hezo/shared';
import { waitFor, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import {
	seedComment,
	seedProject,
	seedRunningAgent,
	seedTask,
	seedWorkspace,
} from './helpers/seed';
import { expandEventGroups } from './helpers/thread';

/** Insert a system event straight onto the task, as the server would. */
async function insertSystemEvent(
	taskId: string,
	kind: string,
	extra: Record<string, unknown> = {},
) {
	const { db } = getTestContext();
	await db.query(
		`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
		 VALUES ($1, NULL, 'system'::comment_content_type, $2::jsonb)`,
		[taskId, JSON.stringify({ kind, ...extra })],
	);
}

/**
 * A thread shaped like the one this redesign is for: a person's comment, a wall
 * of machinery, then another comment.
 */
async function seedNoisyThread(opts: { defaultView?: TaskView } = {}) {
	const seeded = { projectSlug: '', taskId: '' };
	const rendered = await renderApp({
		initialPath: '/',
		seed: async (ctx) => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Noisy Project' });
			const task = await seedTask(ws, project, { title: 'Noisy Task' });
			await seedComment(ws, task, 'Can you work out why engagement dropped?');
			await insertSystemEvent(task.id, 'status_change', { from: 'backlog', to: 'in_progress' });
			await insertSystemEvent(task.id, 'assignee_change');
			await insertSystemEvent(task.id, 'task_link');
			await seedComment(ws, task, 'Reply-rate halved on the 12th.');
			if (opts.defaultView) {
				await ctx.db.query(
					`INSERT INTO system_meta (key, value) VALUES ('default_task_view', $1)
					 ON CONFLICT (key) DO UPDATE SET value = $1`,
					[opts.defaultView],
				);
			}
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
		},
	});
	await rendered.router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});
	return rendered;
}

test('Conversation is the default: comments stay, machinery folds into one chip', async () => {
	const { findByTestId, queryAllByTestId } = await seedNoisyThread();

	await findByTestId('comments-list');
	// Both comments are on screen, unfolded.
	await waitFor(() => {
		expect(document.body.textContent).toContain('Can you work out why engagement dropped?');
	});
	expect(document.body.textContent).toContain('Reply-rate halved on the 12th.');

	// The three contiguous system rows became one chip that says what is inside.
	const groups = queryAllByTestId('event-group');
	expect(groups).toHaveLength(1);
	expect(groups[0].textContent).toContain('3 events');
	expect(groups[0].textContent).toContain('3 changes');
	// Nothing inside it is rendered while it is collapsed.
	expect(queryAllByTestId('event-group-rows')).toHaveLength(0);

	// The badge counts the rows on screen, and the folded ones are tallied beside it.
	expect((await findByTestId('thread-comment-count')).textContent).toBe('2');
	expect((await findByTestId('thread-folded-count')).textContent).toContain('3 events');
});

test('expanding a group reveals the rows it holds', async () => {
	const { findByTestId, queryAllByTestId, user } = await seedNoisyThread();

	await findByTestId('comments-list');
	expect(await expandEventGroups(user)).toBe(1);

	const rows = await findByTestId('event-group-rows');
	expect(within(rows).getAllByTestId('comment-item').length).toBe(3);
	expect((await findByTestId('event-group-toggle')).getAttribute('aria-expanded')).toBe('true');
});

test('Detailed shows every row and folds nothing', async () => {
	const { findByTestId, queryAllByTestId, user } = await seedNoisyThread();
	await findByTestId('comments-list');

	const control = await findByTestId('task-view-segmented');
	await user.click(within(control).getByRole('button', { name: 'Detailed' }));

	await waitFor(() => {
		expect(queryAllByTestId('event-group')).toHaveLength(0);
	});
	// All five rows are on screen, so the badge counts all five.
	await waitFor(() => {
		expect(document.querySelectorAll('[data-testid="comment-item"]').length).toBe(5);
	});
	expect((await findByTestId('thread-comment-count')).textContent).toBe('5');
	expect(document.querySelector('[data-testid="thread-folded-count"]')).toBeNull();
});

test('the rail switch is temporary, and says so only while it is overriding', async () => {
	const { findByTestId, queryByTestId, user } = await seedNoisyThread();
	await findByTestId('comments-list');

	// On the default view the hint stays out of the way.
	expect(queryByTestId('task-view-temporary')).toBeNull();

	const control = await findByTestId('task-view-segmented');
	await user.click(within(control).getByRole('button', { name: 'Detailed' }));
	await findByTestId('task-view-temporary');

	// Back to the default, and the hint goes with it.
	await user.click(within(control).getByRole('button', { name: 'Conversation' }));
	await waitFor(() => {
		expect(queryByTestId('task-view-temporary')).toBeNull();
	});
});

test('the instance default decides which view a task opens in', async () => {
	const { findByTestId, queryAllByTestId } = await seedNoisyThread({
		defaultView: TaskView.Detailed,
	});

	await findByTestId('comments-list');
	await waitFor(() => {
		expect(document.querySelectorAll('[data-testid="comment-item"]').length).toBe(5);
	});
	expect(queryAllByTestId('event-group')).toHaveLength(0);

	// The rail agrees, and shows no override hint - this *is* the default here.
	const control = await findByTestId('task-view-segmented');
	expect(
		within(control).getByRole('button', { name: 'Detailed' }).getAttribute('aria-pressed'),
	).toBe('true');
	expect(document.querySelector('[data-testid="task-view-temporary"]')).toBeNull();
});

test('a live run becomes the working row instead of folding', async () => {
	const seeded = { projectSlug: '', taskId: '' };
	const { findByTestId, queryAllByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Working Project' });
			const task = await seedTask(ws, project, { title: 'Working Task' });
			await seedComment(ws, task, 'Please start.');
			await insertSystemEvent(task.id, 'status_change', { from: 'backlog', to: 'in_progress' });
			await seedRunningAgent(ws, task, ws.agents[0].id);
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
		},
	});
	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	// The run in flight is the current state of the task, so it gets its own row.
	const working = await findByTestId('run-comment-working', undefined, { timeout: 20_000 });
	expect(working.textContent).toContain('is working');
	expect(working.getAttribute('aria-expanded')).toBe('false');

	// The status change beside it still folds - only the live run is exempt.
	const groups = queryAllByTestId('event-group');
	expect(groups).toHaveLength(1);
	expect(groups[0].textContent).toContain('1 event');
});

test('the working row opens onto the live log, with Stop inside it', async () => {
	const seeded = { projectSlug: '', taskId: '' };
	const { findByTestId, queryByTestId, router, user } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Stop Project' });
			const task = await seedTask(ws, project, { title: 'Stop Task' });
			await seedRunningAgent(ws, task, ws.agents[0].id);
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
		},
	});
	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	const working = await findByTestId('run-comment-working', undefined, { timeout: 20_000 });
	// Collapsed by default: a live terminal at the foot of every busy task is the
	// noise this view exists to remove.
	expect(queryByTestId('run-comment-log')).toBeNull();

	await user.click(working);
	await findByTestId('run-comment-log');
	// Stop rides in the log header, so it is one click from the working row.
	await findByTestId('terminate-run-button');
	expect(working.getAttribute('aria-expanded')).toBe('true');
});

test('a succeeded latest run folds - there is nothing to act on', async () => {
	const seeded = { projectSlug: '', taskId: '' };
	const { findByTestId, queryByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async (ctx) => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Succeeded Project' });
			const task = await seedTask(ws, project, { title: 'Succeeded Task' });
			await seedComment(ws, task, 'Please start.');
			const { runId } = await seedRunningAgent(ws, task, ws.agents[0].id);
			// Finish it: the newest run in the thread, but it offers no Retry, so the
			// fold rule must treat it like any other completed run.
			await ctx.db.query(
				`UPDATE heartbeat_runs SET status = 'succeeded'::heartbeat_run_status,
				        finished_at = now() WHERE id = $1`,
				[runId],
			);
			await ctx.db.query(`DELETE FROM execution_locks WHERE task_id = $1`, [task.id]);
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
		},
	});
	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	await findByTestId('event-group', undefined, { timeout: 20_000 });
	expect(queryByTestId('run-comment-working')).toBeNull();
	// The run is inside the group, not beside it.
	expect(queryByTestId('run-comment-summary')).toBeNull();
});

test('a deep link into a folded row expands its group', async () => {
	const seeded = { projectSlug: '', taskId: '', publicId: '' };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async (ctx) => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Deep Link Project' });
			const task = await seedTask(ws, project, { title: 'Deep Link Task' });
			await seedComment(ws, task, 'First.');
			const inserted = await ctx.db.query<{ public_id: string }>(
				`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
				 VALUES ($1, NULL, 'system'::comment_content_type, $2::jsonb)
				 RETURNING public_id`,
				[task.id, JSON.stringify({ kind: 'status_change', from: 'backlog', to: 'in_progress' })],
			);
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
			seeded.publicId = inserted.rows[0].public_id;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
		hash: `comment-${seeded.publicId}`,
	});

	// The target row is inside a collapsed group; the link has to open it, or the
	// anchor lands on nothing.
	const rows = await findByTestId('event-group-rows', undefined, { timeout: 20_000 });
	expect(rows.querySelector(`#comment-${seeded.publicId}`)).not.toBeNull();
});
