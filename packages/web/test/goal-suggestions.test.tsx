import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import {
	type SeededProject,
	type SeededWorkspace,
	seedProject,
	seedWorkspace,
} from './helpers/seed';

// The Goals page surfaces pending goal *suggestions* (Captain/CEO proposals) with
// inline Approve/Deny; approving creates the real goal. Driven through the real
// backend, no CSS/layout dependency → component test.
test('the Goals page shows a pending suggestion and approving it creates the goal', async () => {
	let ws!: SeededWorkspace;
	let project!: SeededProject;
	const { findByTestId, findByText, queryByText, user, router } = await renderApp({
		initialPath: '/',
		seed: async (ctx) => {
			ws = await seedWorkspace();
			project = await seedProject(ws, { name: 'Growth' });
			await ctx.db.query(
				`INSERT INTO approvals (team_id, type, payload, status)
				 VALUES ($1, 'goal_suggestion'::approval_type, $2::jsonb, 'pending'::approval_status)`,
				[
					ws.team.id,
					JSON.stringify({
						project_id: project.id,
						title: 'Reach 5k followers',
						measurement: '5000 followers on the connected account',
						check_frequency: 'weekly',
					}),
				],
			);
		},
	});

	await router.navigate({
		to: '/projects/$projectId/progress/goals',
		params: { projectId: project.slug },
	});

	// The suggestion renders in its own section; it is NOT yet a goal.
	await findByTestId('goal-suggestions', undefined, { timeout: 15_000 });
	await findByText('Reach 5k followers');
	// The section header carries an info tooltip explaining what a goal is.
	await findByTestId('suggested-goals-info');

	// Approve it → the real goal is created and the suggestion clears.
	await user.click(await findByTestId('goal-suggestion-approve'));

	// The goal now renders as a goal panel; the pending-suggestion section is gone.
	await findByTestId('goals-new-goal', undefined, { timeout: 15_000 });
	expect(queryByText(/Approve to create this goal/)).toBeNull();
	await findByText('Reach 5k followers');
});
