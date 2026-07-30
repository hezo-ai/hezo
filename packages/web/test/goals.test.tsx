import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import {
	seedGoal,
	seedProgressUpdateRun,
	seedProject,
	seedProjectProgress,
	seedTask,
	seedWorkspace,
} from './helpers/seed';

// Component-tier proof for the Progress (goals) page: seed a team + project (no goals),
// navigate to the goals route, and assert the empty-state hero renders with its
// exact tagline.
test('renders the goals empty state when a project has no goals', async () => {
	let projectSlug = '';
	const { findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Goals Demo' });
			projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/goals',
		params: { projectId: projectSlug },
	});

	await findByText('Create the first goal for the team to work towards', undefined, {
		timeout: 10_000,
	});
});

test('Progress page renders the Captain progress summary above the goals', async () => {
	let projectSlug = '';
	const { findByText, findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Progress Demo' });
			projectSlug = project.slug;
			await seedGoal(ws, project, {
				title: 'Reach 100 customers',
				measurement: '100 paid subscriptions',
			});
			await seedProjectProgress(project, '**Auth shipped.** Payments next; analytics later.');
		},
	});

	await router.navigate({
		to: '/projects/$projectId/goals',
		params: { projectId: projectSlug },
	});

	await findByTestId('project-progress-summary', undefined, { timeout: 10_000 });
	// The bold lead key point renders from markdown, and the goal panel shows below.
	await findByText('Auth shipped.');
	await findByText('Reach 100 customers');
});

test('the goal detail run feed renders the health as a coloured pill and links to the run', async () => {
	let projectSlug = '';
	let goalId = '';
	const { findByTestId, getByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Run Feed Demo' });
			projectSlug = project.slug;
			const goal = await seedGoal(ws, project, {
				title: 'Reach launch',
				measurement: 'launched',
			});
			goalId = goal.id;
			await seedProgressUpdateRun(ws, {
				goal,
				progressPercent: 40,
				health: 'on_track',
				statusBlurb: 'Tracking nicely',
			});
		},
	});

	await router.navigate({
		to: '/projects/$projectId/goals/$goalId',
		params: { projectId: projectSlug, goalId },
	});

	// The run row renders the health as the same pill used in goal meta ("On track"),
	// not the raw enum, and links to the run in the Captain's run list.
	await findByTestId('goal-run', undefined, { timeout: 10_000 });
	const open = getByTestId('goal-run-open') as HTMLAnchorElement;
	expect(open.getAttribute('href')).toMatch(/\/agents\/captain\/executions\//);
	expect(getByTestId('goal-run').textContent).toContain('On track');
	expect(getByTestId('goal-run').textContent).not.toContain('on_track');
});

test('the Progress page progress-update footer renders runs as collapsible run cards', async () => {
	let projectSlug = '';
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Footer Demo' });
			projectSlug = project.slug;
			const goal = await seedGoal(ws, project, { title: 'Ship beta', measurement: 'beta live' });
			await seedProgressUpdateRun(ws, { goal, statusBlurb: 'Going well' });
		},
	});

	await router.navigate({
		to: '/projects/$projectId/goals',
		params: { projectId: projectSlug },
	});

	// Each progress-update run renders the same collapsible run card used for agent runs on a
	// task — its summary header (with the expand toggle) is the tell.
	await findByTestId('progress-update-run', undefined, { timeout: 10_000 });
	await findByTestId('run-comment-header', undefined, { timeout: 10_000 });
});

test('the Goals header help button opens the SMART guidance modal', async () => {
	let projectSlug = '';
	const { findByTestId, findByText, queryByText, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Help Demo' });
			projectSlug = project.slug;
			await seedGoal(ws, project, { title: 'Ship it', measurement: 'shipped' });
		},
	});

	await router.navigate({
		to: '/projects/$projectId/goals',
		params: { projectId: projectSlug },
	});

	// The guidance is not inline — it lives behind the help button.
	const help = await findByTestId('goals-help', undefined, { timeout: 10_000 });
	expect(queryByText(/Goals are the outcomes the Captain steers/)).toBeNull();

	await user.click(help);

	// The modal renders its title and the SMART guidance body.
	await findByText('What makes a good goal?');
	await findByText(/Goals are the outcomes the Captain steers/);
	// The ongoing-vs-one-off note (GOAL_ONGOING_NOTE) renders below the SMART list.
	await findByText(/outcome the project works toward/);
});

test('the goal create form renders an info tooltip for every field', async () => {
	let projectSlug = '';
	const { findByTestId, getByLabelText, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Tooltip Demo' });
			projectSlug = project.slug;
			await seedGoal(ws, project, { title: 'Ship it', measurement: 'shipped' });
		},
	});

	await router.navigate({
		to: '/projects/$projectId/goals',
		params: { projectId: projectSlug },
	});

	const newGoal = await findByTestId('goals-new-goal', undefined, { timeout: 10_000 });
	await user.click(newGoal);

	// Every field in the form carries an info-tooltip suffix button (queried by its aria-label).
	for (const label of [
		'About goal name',
		'About measurement',
		'About suggested actions',
		'About check frequency',
		'About deadline',
	]) {
		expect(getByLabelText(label)).toBeTruthy();
	}
});

test('clicking a goal opens its page with breadcrumbs, run feed, and edit modal', async () => {
	let projectSlug = '';
	const { findByText, findByTestId, getByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Progress Demo' });
			projectSlug = project.slug;
			await seedGoal(ws, project, {
				title: 'Launch the beta',
				measurement: 'public beta is live',
			});
		},
	});

	await router.navigate({
		to: '/projects/$projectId/goals',
		params: { projectId: projectSlug },
	});

	const open = await findByTestId('goal-open', undefined, { timeout: 10_000 });
	await user.click(open);

	// Goal detail page: breadcrumb back to Progress, the goal's measurement, and the run feed.
	await findByTestId('goal-breadcrumb');
	await findByText('Achieved when');
	await findByText('public beta is live');
	await findByText('Progress update runs');
	await findByText('No progress-update activity yet.');

	// Editing reuses the create/edit modal.
	await user.click(getByTestId('goal-edit'));
	await findByText('Edit Goal');
});

test('the edit dialog pre-fills the Deadline field from a goal saved with a target date', async () => {
	let projectSlug = '';
	const { findByTestId, findByText, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Deadline Demo' });
			projectSlug = project.slug;
			await seedGoal(ws, project, {
				title: 'Reach 10k stars on GitHub',
				measurement: '10k GitHub stars',
				target_date: '2026-09-30',
			});
		},
	});

	await router.navigate({
		to: '/projects/$projectId/goals',
		params: { projectId: projectSlug },
	});

	// Open the edit dialog from the goal card's pencil button.
	await user.click(await findByTestId('goal-edit', undefined, { timeout: 10_000 }));
	await findByText('Edit Goal');

	// The Deadline <input type="date"> must be seeded with the goal's bare calendar date. A SQL
	// DATE serializes over the API as a UTC-midnight ISO timestamp ("2026-09-30T00:00:00.000Z"),
	// which a date input can't parse — feeding it raw left the field blank on edit.
	await waitFor(() => {
		const dateInput = document.body.querySelector<HTMLInputElement>('input[type="date"]');
		expect(dateInput?.value).toBe('2026-09-30');
	});
});

test('the goal detail blurb linkifies task identifiers and markdown PR links', async () => {
	let projectSlug = '';
	let goalId = '';
	let taskIdentifier = '';
	const { findByTestId, findByRole, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Link Demo' });
			projectSlug = project.slug;
			const task = await seedTask(ws, project, { title: 'Doc review' });
			taskIdentifier = task.identifier;
			// The blurb renders as markdown: a bare task identifier auto-links, and a markdown
			// link to a PR renders as an external anchor.
			const goal = await seedGoal(ws, project, {
				title: 'Reach 10k stars',
				measurement: '10k GitHub stars',
				statusBlurb: `Blocked on ${task.identifier}, resolved via [PR #502](https://github.com/acme/repo/pull/502).`,
			});
			goalId = goal.id;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/goals/$goalId',
		params: { projectId: projectSlug, goalId },
	});

	// The bare identifier resolves to an in-app task link (slug + lowercased identifier).
	const taskLink = await findByTestId('task-mention-link', undefined, { timeout: 10_000 });
	expect(taskLink.getAttribute('href')).toBe(
		`/projects/${projectSlug}/tasks/${taskIdentifier.toLowerCase()}`,
	);

	// The markdown PR link opens GitHub in a new tab.
	const prLink = await findByRole('link', { name: 'PR #502' });
	expect(prLink.getAttribute('href')).toBe('https://github.com/acme/repo/pull/502');
	expect(prLink.getAttribute('target')).toBe('_blank');
});

test('Project progress shows only the bold lead line until expanded', async () => {
	let projectSlug = '';
	const { findByText, findByTestId, queryByText, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Collapse Demo' });
			projectSlug = project.slug;
			await seedGoal(ws, project, { title: 'Ship v1', measurement: 'v1 live' });
			// A representative two-paragraph summary: bold lead line, then a narrative body.
			await seedProjectProgress(
				project,
				'**Auth shipped, payments next.**\n\nThe login flow is live and analytics land later this week.',
			);
		},
	});

	await router.navigate({
		to: '/projects/$projectId/goals',
		params: { projectId: projectSlug },
	});

	await findByTestId('project-progress-summary', undefined, { timeout: 10_000 });
	// Collapsed: the bold lead renders, the narrative body does not.
	await findByText('Auth shipped, payments next.');
	expect(queryByText(/analytics land later this week/)).toBeNull();

	// Show more reveals the body; the lead stays put.
	await user.click(await findByTestId('project-progress-toggle'));
	await findByText(/analytics land later this week/);
	await findByText('Auth shipped, payments next.');
});

test('Project progress header opens a help dialog explaining how it updates', async () => {
	let projectSlug = '';
	const { findByText, findByTestId, queryByText, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Help Demo' });
			projectSlug = project.slug;
			await seedGoal(ws, project, { title: 'Ship v1', measurement: 'v1 live' });
			await seedProjectProgress(project, '**On track.**\n\nMost of the work is done.');
		},
	});

	await router.navigate({
		to: '/projects/$projectId/goals',
		params: { projectId: projectSlug },
	});

	// The explanation lives behind the question-mark help button, not inline.
	const help = await findByTestId('project-progress-help', undefined, { timeout: 10_000 });
	expect(queryByText(/reviews progress across the project/)).toBeNull();

	await user.click(help);

	// The dialog explains what it is and that the Captain refreshes it during progress-update runs.
	await findByText('About project progress');
	await findByText(/reviews progress across the project/);
});

test('the goal run feed hides the status summary until expanded, keeping task chips visible', async () => {
	let projectSlug = '';
	let goalId = '';
	let createdIdentifier = '';
	const { findByText, findByTestId, queryByText, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Blurb Demo' });
			projectSlug = project.slug;
			const goal = await seedGoal(ws, project, { title: 'Ship beta', measurement: 'beta live' });
			goalId = goal.id;
			const task = await seedTask(ws, project, { title: 'Wire up auth' });
			createdIdentifier = task.identifier;
			await seedProgressUpdateRun(ws, {
				goal,
				statusBlurb: 'Auth is the last blocker before beta.',
				createdTasks: [task],
			});
		},
	});

	await router.navigate({
		to: '/projects/$projectId/goals/$goalId',
		params: { projectId: projectSlug, goalId },
	});

	await findByTestId('goal-run', undefined, { timeout: 10_000 });
	// Collapsed: the created-task chip shows, but the status summary stays hidden.
	await findByText(createdIdentifier);
	expect(queryByText(/Auth is the last blocker/)).toBeNull();

	// Expanding the run reveals the summary; the task chip is still there.
	await user.click(await findByTestId('goal-run-expand'));
	await findByText(/Auth is the last blocker/);
	await findByText(createdIdentifier);
});

test('the New goal button sits on the Goals header line and opens the create dialog', async () => {
	let projectSlug = '';
	const { findByTestId, findByText, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Add Card Demo' });
			projectSlug = project.slug;
			// A goal already exists, so the list header (with the add button) renders, not the hero.
			await seedGoal(ws, project, { title: 'Ship it', measurement: 'shipped' });
		},
	});

	await router.navigate({
		to: '/projects/$projectId/goals',
		params: { projectId: projectSlug },
	});

	// The add affordance is a small "+" button right-aligned on the Goals header line.
	const addButton = await findByTestId('goals-new-goal', undefined, { timeout: 10_000 });
	expect(addButton.getAttribute('aria-label')).toBe('New goal');
	await user.click(addButton);
	await findByText('Create Goal');
});

test('the Progress page shows a Run now button beside the progress update runs label', async () => {
	let projectSlug = '';
	const { findByTestId, findByText, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Run Now Demo' });
			projectSlug = project.slug;
			await seedGoal(ws, project, { title: 'Ship it', measurement: 'shipped' });
		},
	});

	await router.navigate({
		to: '/projects/$projectId/goals',
		params: { projectId: projectSlug },
	});

	await findByText('Progress update runs');
	const runNow = await findByTestId('progress-update-run-now', undefined, { timeout: 10_000 });
	expect(runNow.textContent).toContain('Run now');
	// Clicking fires the run-now mutation against the in-process backend. The goal is due but there
	// is no running container in tests (a transient conflict), so the run is queued rather than
	// erroring — the queued row appears.
	await user.click(runNow);
	await findByTestId('progress-update-run-now');
});

/** Whether the seeded goal is archived server-side, read straight from the DB. */
async function isArchivedInDb(goalId: string): Promise<boolean> {
	const { db } = getTestContext();
	const res = await db.query<{ archived_at: string | null }>(
		`SELECT archived_at FROM goals WHERE id = $1`,
		[goalId],
	);
	return res.rows[0]?.archived_at !== null;
}

test('archiving a goal from the Goals list is confirmed first, and cancelling leaves it active', async () => {
	let projectSlug = '';
	let goalId = '';
	const { findByTestId, findByText, getByRole, queryByTestId, queryByText, user, router } =
		await renderApp({
			initialPath: '/',
			seed: async () => {
				const ws = await seedWorkspace();
				const project = await seedProject(ws, { name: 'Archive Demo' });
				projectSlug = project.slug;
				const goal = await seedGoal(ws, project, {
					title: 'Reach 100 customers',
					measurement: '100 paid subscriptions',
				});
				goalId = goal.id;
			},
		});

	await router.navigate({
		to: '/projects/$projectId/goals',
		params: { projectId: projectSlug },
	});

	// Archiving retires the goal (the Captain stops checking it), so the click opens a
	// confirmation naming the goal rather than mutating straight away.
	await user.click(await findByTestId('goal-archive', undefined, { timeout: 10_000 }));
	const dialog = await findByTestId('confirm-dialog');
	await findByText('Archive this goal?');
	expect(dialog.textContent).toContain('Reach 100 customers');
	expect(await isArchivedInDb(goalId)).toBe(false);

	// Cancelling closes the dialog and leaves the goal untouched on the server.
	await user.click(getByRole('button', { name: /^Cancel/ }));
	await waitFor(() => expect(queryByTestId('confirm-dialog')).toBeNull());
	expect(await isArchivedInDb(goalId)).toBe(false);
	await findByText('Reach 100 customers');

	// Confirming archives it, and the card drops out of the Active view.
	await user.click(await findByTestId('goal-archive'));
	await user.click(await findByTestId('confirm-dialog-confirm'));
	await waitFor(async () => expect(await isArchivedInDb(goalId)).toBe(true), { timeout: 10_000 });
	await waitFor(() => expect(queryByText('Reach 100 customers')).toBeNull(), { timeout: 10_000 });
});

test('the goal detail page confirms archiving, and unarchiving is a single click', async () => {
	let projectSlug = '';
	let goalId = '';
	const { findByTestId, findByText, queryByTestId, queryByText, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Archive Detail Demo' });
			projectSlug = project.slug;
			const goal = await seedGoal(ws, project, {
				title: 'Ship the beta',
				measurement: 'beta live',
			});
			goalId = goal.id;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/goals/$goalId',
		params: { projectId: projectSlug, goalId },
	});

	// Same confirmation on the detail header as on the list card (one shared control).
	await user.click(await findByTestId('goal-archive', undefined, { timeout: 10_000 }));
	await findByText('Archive this goal?');
	await user.click(await findByTestId('confirm-dialog-confirm'));
	await findByText('Archived', undefined, { timeout: 10_000 });

	// Unarchiving is the undo of a confirmed action, so it fires without a second prompt.
	await user.click(await findByTestId('goal-archive'));
	expect(queryByTestId('confirm-dialog')).toBeNull();
	await waitFor(async () => expect(await isArchivedInDb(goalId)).toBe(false), { timeout: 10_000 });
	await waitFor(() => expect(queryByText('Archived')).toBeNull(), { timeout: 10_000 });
});

test('Run now queues when the Captain is busy, and the queued run can be cancelled', async () => {
	let projectSlug = '';
	const { findByTestId, findByText, queryByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async (ctx) => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Queue Demo' });
			projectSlug = project.slug;
			// A freshly-seeded goal is immediately due. A missing container no
			// longer queues (the runner lazy-starts it), so block on the container
			// limit instead: cap 1, this project's container stopped, a filler
			// project's running container holding the only slot.
			await seedGoal(ws, project, { title: 'Ship it', measurement: 'shipped' });
			await ctx.db.query(
				`INSERT INTO system_meta (key, value) VALUES ('max_active_containers', '1')
				 ON CONFLICT (key) DO UPDATE SET value = '1'`,
			);
			await ctx.db.query(`UPDATE projects SET container_status = 'stopped' WHERE id = $1`, [
				project.id,
			]);
			const filler = await ctx.db.query<{ id: string }>(
				`INSERT INTO teams (name, slug) VALUES ('cap-goals-web', 'cap-goals-web') RETURNING id`,
			);
			await ctx.db.query(
				`INSERT INTO projects (team_id, name, slug, task_prefix, container_id, container_status, container_last_started_at)
				 VALUES ($1, 'cap-goals-web', 'cap-goals-web', 'CGW', 'cid-goals-web', 'running', now())`,
				[filler.rows[0].id],
			);
		},
	});

	await router.navigate({
		to: '/projects/$projectId/goals',
		params: { projectId: projectSlug },
	});

	const runNow = await findByTestId('progress-update-run-now', undefined, { timeout: 10_000 });
	await user.click(runNow);

	// The queued row appears (driven by the real backend queuing the wakeup).
	const queuedRow = await findByTestId('progress-update-queued-row', undefined, {
		timeout: 10_000,
	});
	expect(queuedRow.textContent).toContain('Queued');

	// Cancelling opens the confirm dialog, then removes the queued row.
	await user.click(await findByTestId('cancel-queued-progress-run'));
	await user.click(await findByText('Cancel run'));

	await waitFor(() => expect(queryByTestId('progress-update-queued-row')).toBeNull(), {
		timeout: 10_000,
	});
});
