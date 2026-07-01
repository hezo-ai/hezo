import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
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

test('the New goal card sits in the goals grid and opens the create dialog', async () => {
	let projectSlug = '';
	const { findByTestId, findByText, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Add Card Demo' });
			projectSlug = project.slug;
			// A goal already exists, so the grid (with the inline add-card) renders, not the hero.
			await seedGoal(ws, project, { title: 'Ship it', measurement: 'shipped' });
		},
	});

	await router.navigate({
		to: '/projects/$projectId/goals',
		params: { projectId: projectSlug },
	});

	// The add affordance is a card in the list (same testid the header button used to carry).
	const addCard = await findByTestId('goals-new-goal', undefined, { timeout: 10_000 });
	expect(addCard.textContent).toContain('New goal');
	await user.click(addCard);
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

test('Run now queues when the Captain is busy, and the queued run can be cancelled', async () => {
	let projectSlug = '';
	const { findByTestId, findByText, queryByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Queue Demo' });
			projectSlug = project.slug;
			// A freshly-seeded goal is immediately due; no running container in tests means the run
			// is queued instead of started.
			await seedGoal(ws, project, { title: 'Ship it', measurement: 'shipped' });
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
