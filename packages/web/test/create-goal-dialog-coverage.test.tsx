import { GoalCheckFrequency } from '@hezo/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import {
	type SeededProject,
	type SeededWorkspace,
	seedGoal,
	seedProject,
	seedWorkspace,
} from './helpers/seed';

// Component tier (happy-dom). Drives the CreateGoalDialog through the real
// Progress page. Covers the create-disabled (empty title) branch, a successful
// create with a chosen check frequency, and the edit-mode branch (form seeded
// from the goal, then Save). The dialog renders into a Radix portal on
// document.body.

async function openGoalsPage(
	seed: (ctx: { ws: SeededWorkspace; project: SeededProject }) => Promise<void>,
) {
	const ref = { slug: '' };
	const helpers = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Goal Dialog Project' });
			ref.slug = project.slug;
			await seed({ ws, project });
		},
	});
	await helpers.router.navigate({
		to: '/projects/$projectId/goals',
		params: { projectId: ref.slug },
	});
	return { ...helpers, ref };
}

test('create dialog: submit is disabled until a title is entered, then creates with the chosen frequency', async () => {
	const { findByTestId, user } = await openGoalsPage(async () => {});

	// Empty-state CTA opens the create dialog.
	const cta = await findByTestId('goals-empty-create', undefined, { timeout: 15_000 });
	await user.click(cta);

	const dialog = (await screen.findByRole('dialog')) as HTMLElement;
	expect(within(dialog).getByText('Create Goal')).toBeTruthy();

	// Create button is disabled with an empty title.
	const createBtn = within(dialog).getByRole('button', { name: 'Create' }) as HTMLButtonElement;
	expect(createBtn.disabled).toBe(true);

	const nameInput = within(dialog).getByLabelText('Goal name') as HTMLInputElement;
	await user.type(nameInput, 'Ship the dialog');
	expect(createBtn.disabled).toBe(false);

	// Pick a non-default check frequency (default is Daily).
	const freqSelect = within(dialog).getByRole('combobox') as HTMLSelectElement;
	await user.selectOptions(freqSelect, GoalCheckFrequency.Weekly);
	expect(freqSelect.value).toBe(GoalCheckFrequency.Weekly);

	await user.click(createBtn);

	// The dialog closes and the goal lands with the chosen frequency.
	await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: 15_000 });
	await waitFor(
		async () => {
			const r = await getTestContext().db.query<{ check_frequency: string }>(
				`SELECT check_frequency FROM goals WHERE title = 'Ship the dialog'`,
			);
			expect(r.rows.length).toBe(1);
			expect(r.rows[0].check_frequency).toBe(GoalCheckFrequency.Weekly);
		},
		{ timeout: 15_000 },
	);
});

test('edit dialog: seeds the form from the goal and saves an updated title', async () => {
	let goalId = '';
	const { findByTestId, getByTestId, user } = await openGoalsPage(async ({ ws, project }) => {
		const goal = await seedGoal(ws, project, {
			title: 'Original goal title',
			measurement: 'original measure',
		});
		goalId = goal.id;
	});

	// Open the edit dialog from the goal's edit button.
	await findByTestId('goal-edit', undefined, { timeout: 15_000 });
	await user.click(getByTestId('goal-edit'));

	const heading = await screen.findByText('Edit Goal');
	const dialog = heading.closest('[role="dialog"]') as HTMLElement;

	// The form is seeded from the goal being edited.
	const nameInput = within(dialog).getByLabelText('Goal name') as HTMLInputElement;
	await waitFor(() => expect(nameInput.value).toBe('Original goal title'));

	await user.clear(nameInput);
	await user.type(nameInput, 'Updated goal title');

	// Edit mode shows a Save button (not Create).
	const saveBtn = within(dialog).getByRole('button', { name: 'Save' });
	await user.click(saveBtn);

	await waitFor(() => expect(screen.queryByText('Edit Goal')).toBeNull(), { timeout: 15_000 });
	await waitFor(
		async () => {
			const r = await getTestContext().db.query<{ title: string }>(
				`SELECT title FROM goals WHERE id = $1`,
				[goalId],
			);
			expect(r.rows[0].title).toBe('Updated goal title');
		},
		{ timeout: 15_000 },
	);
});
