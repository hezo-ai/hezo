import { GoalHealth } from '@hezo/shared';
import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedGoal, seedProject, seedProjectProgress, seedWorkspace } from './helpers/seed';

// The Progress page's three columns are a frozen snapshot the Captain writes, so these seed the
// snapshot directly rather than driving a run.
const SNAPSHOT = {
	actioned: [
		{
			identifier: 'PR-1',
			title: 'Card payments',
			summary: 'Live cards work end to end; refunds are the last gap.',
		},
	],
	created: [
		{
			identifier: 'PR-2',
			title: 'Split the billing migration',
			summary: 'Breaks the one long migration into three, to de-risk the release.',
		},
	],
	closed: [
		{
			identifier: 'PR-3',
			title: 'Verify webhooks',
			summary: 'Payment confirmations are now trusted end to end.',
		},
	],
};

test('the Progress page renders all three activity columns with the Captain lines', async () => {
	let projectSlug = '';
	const { findByText, findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Columns Demo' });
			projectSlug = project.slug;
			await seedProjectProgress(project, '**Payments are close.**', SNAPSHOT);
		},
	});

	await router.navigate({
		to: '/projects/$projectId/progress',
		params: { projectId: projectSlug },
	});

	await findByTestId('progress-columns', undefined, { timeout: 10_000 });
	// Scope to the desktop grid: happy-dom applies no media queries, so the mobile tab panel is
	// in the DOM too and an unscoped query matches the active column twice.
	for (const [kind, title, summary] of [
		['actioned', 'Card payments', 'Live cards work end to end; refunds are the last gap.'],
		[
			'created',
			'Split the billing migration',
			'Breaks the one long migration into three, to de-risk the release.',
		],
		['closed', 'Verify webhooks', 'Payment confirmations are now trusted end to end.'],
	] as const) {
		const column = await findByTestId(`progress-column-${kind}`);
		expect(column.textContent).toContain(title);
		expect(column.textContent).toContain(summary);
	}
});

// The Captain's line is bounded to a complete sentence on write, so the row shows it whole. A
// `line-clamp` here would put an ellipsis back over a thought that had already finished.
test('a task row renders the whole Captain line rather than clamping it', async () => {
	const LONG =
		'Live cards work end to end and the provider webhooks are trusted, so refunds are now the only gap left before the payments work can close.';
	let projectSlug = '';
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Unclamped Demo' });
			projectSlug = project.slug;
			await seedProjectProgress(project, '**Payments are close.**', {
				actioned: [{ identifier: 'PR-1', title: 'Card payments', summary: LONG }],
			});
		},
	});

	await router.navigate({
		to: '/projects/$projectId/progress',
		params: { projectId: projectSlug },
	});

	const column = await findByTestId('progress-column-actioned', undefined, { timeout: 10_000 });
	const line = (await waitFor(() => {
		const el = column.querySelector('[data-testid="progress-task-row"] p');
		if (!el) throw new Error('task row not rendered yet');
		return el;
	})) as HTMLParagraphElement;
	expect(line.textContent).toBe(LONG);
	// happy-dom runs no layout, so the clamp can only be checked as the class that applies it.
	expect(line.className).not.toContain('line-clamp');
});

test('a task row links to that task', async () => {
	let projectSlug = '';
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Link Demo' });
			projectSlug = project.slug;
			await seedProjectProgress(project, '**Summary.**', SNAPSHOT);
		},
	});

	await router.navigate({
		to: '/projects/$projectId/progress',
		params: { projectId: projectSlug },
	});

	const column = await findByTestId('progress-column-actioned', undefined, { timeout: 10_000 });
	// The column mounts before the snapshot arrives, so wait for the row itself.
	const link = (await waitFor(() => {
		const el = column.querySelector('[data-testid="progress-task-link"]');
		if (!el) throw new Error('task row not rendered yet');
		return el;
	})) as HTMLAnchorElement;
	expect(link.textContent).toBe('PR-1');
	// The identifier lowercases into the task URL, which is how task routes are addressed.
	expect(link.getAttribute('href')).toBe(`/projects/${projectSlug}/tasks/pr-1`);
});

// A project that has never had a progress-update run should say why the columns are empty,
// rather than reading as "there is no work".
test('empty columns explain that the Captain fills them during a progress update', async () => {
	let projectSlug = '';
	const { findAllByText, findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Empty Demo' });
			projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/progress',
		params: { projectId: projectSlug },
	});

	await findByTestId('progress-columns', undefined, { timeout: 10_000 });
	const notices = await findAllByText('The Captain fills these in during a progress update.');
	// One per column at the desktop breakpoint, plus the mobile panel.
	expect(notices.length).toBeGreaterThanOrEqual(3);
});

test('the goal indicator shows overall progress and links to the goals page', async () => {
	let projectSlug = '';
	const { findByTestId, findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Indicator Demo' });
			projectSlug = project.slug;
			await seedGoal(ws, project, { title: 'Ship v1', measurement: 'v1 live' });
			await seedGoal(ws, project, { title: 'Cut cost', measurement: 'under $1' });
			await seedProjectProgress(project, '**Summary.**');
		},
	});

	await router.navigate({
		to: '/projects/$projectId/progress',
		params: { projectId: projectSlug },
	});

	const indicator = await findByTestId('goal-progress-indicator', undefined, { timeout: 10_000 });
	expect(indicator.getAttribute('href')).toBe(`/projects/${projectSlug}/progress/goals`);
	// One segment per goal, and the caption counts them.
	const segments = indicator.querySelectorAll('[data-testid="goal-progress-segment"]');
	expect(segments.length).toBe(2);
	await findByText('Goals: 2');
});

// With no goals the indicator becomes the nudge to create the first one, pointing at the same
// page - a project with no goals still has a working Progress page around it.
test('with no goals the indicator invites setting the first one', async () => {
	let projectSlug = '';
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'No Goals Demo' });
			projectSlug = project.slug;
			await seedProjectProgress(project, '**Summary with no goals.**');
		},
	});

	await router.navigate({
		to: '/projects/$projectId/progress',
		params: { projectId: projectSlug },
	});

	const empty = await findByTestId('goal-progress-indicator-empty', undefined, { timeout: 10_000 });
	expect(empty.textContent).toContain('Set the first goal');
	expect(empty.getAttribute('href')).toBe(`/projects/${projectSlug}/progress/goals`);
});

// Health drives the segment colour, not the percentage: an off-track goal at 80% must read as a
// problem rather than as nearly done.
test('the indicator tints each segment by goal health and counts the off-track ones', async () => {
	let projectSlug = '';
	const { findByTestId, findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Health Demo' });
			projectSlug = project.slug;
			const goal = await seedGoal(ws, project, { title: 'Slipping', measurement: 'never' });
			const { db } = await import('./helpers/render').then((m) => m.getTestContext());
			await db.query(
				`UPDATE goals SET progress_percent = 80, health = $1::goal_health WHERE id = $2`,
				[GoalHealth.OffTrack, goal.id],
			);
			await seedProjectProgress(project, '**Summary.**');
		},
	});

	await router.navigate({
		to: '/projects/$projectId/progress',
		params: { projectId: projectSlug },
	});

	const indicator = await findByTestId('goal-progress-indicator', undefined, { timeout: 10_000 });
	const fill = indicator.querySelector('[data-testid="goal-progress-segment"] > span');
	expect(fill?.className).toContain('bg-danger');
	await findByText(/Off track: 1/);
});

// The old flat URLs stay alive so bookmarks and links already written into comments keep working.
test('the pre-nesting goals URL redirects to the nested one', async () => {
	let projectSlug = '';
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Redirect Demo' });
			projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/goals',
		params: { projectId: projectSlug },
	});

	await findByTestId('goals-breadcrumb', undefined, { timeout: 10_000 });
	expect(router.state.location.pathname).toBe(`/projects/${projectSlug}/progress/goals`);
});
