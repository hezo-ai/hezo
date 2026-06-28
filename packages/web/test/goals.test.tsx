import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedGoal, seedProject, seedProjectProgress, seedWorkspace } from './helpers/seed';

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
	await findByText('Goal heartbeat runs');
	await findByText('No goal-check activity yet.');

	// Editing reuses the create/edit modal.
	await user.click(getByTestId('goal-edit'));
	await findByText('Edit Goal');
});
