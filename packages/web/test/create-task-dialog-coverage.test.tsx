import { CAPTAIN_AGENT_SLUG } from '@hezo/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { seedProject, seedWorkspace } from './helpers/seed';

// Component tier (happy-dom). Drives the CreateTaskDialog through the real task
// list. Covers the submit-disabled-until-assignee branch, the "more options"
// disclosure that reveals the Priority select, a successful create that
// navigates to the new task, and the internal-project branch that restricts the
// assignee list to the Captain. The dialog renders into a Radix portal on
// document.body.

async function openTaskListDialog(seed: (project: { slug: string }) => Promise<void>) {
	const ref = { slug: '' };
	const helpers = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Task Dialog Project' });
			ref.slug = project.slug;
			await seed(project);
		},
	});
	await helpers.router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: ref.slug },
	});
	return { ...helpers, ref };
}

test('create disabled until assignee picked; more-toggle reveals priority; creates and navigates', async () => {
	const { findByTestId, user, router } = await openTaskListDialog(async () => {});

	const newBtn = await findByTestId('task-list-new-task', undefined, { timeout: 15_000 });
	await user.click(newBtn);

	const heading = await screen.findByText('Create Task');
	const dialog = heading.closest('[role="dialog"]') as HTMLElement;
	expect(dialog).toBeTruthy();

	const createBtn = within(dialog).getByRole('button', { name: 'Create' }) as HTMLButtonElement;
	// Disabled with no title and no assignee.
	expect(createBtn.disabled).toBe(true);

	const titleInput = within(dialog).getByLabelText('Title') as HTMLInputElement;
	await user.type(titleInput, 'Investigate flake');
	// Still disabled: assignee is required.
	expect(createBtn.disabled).toBe(true);

	// The Priority select is hidden until the "more options" disclosure is opened.
	expect(within(dialog).queryByText('Priority')).toBeNull();
	await user.click(within(dialog).getByTestId('create-task-more-toggle'));
	await within(dialog).findByText('Priority');
	const prioOptions = within(dialog).getAllByRole('combobox');
	// The priority select is the one whose options include "Urgent".
	const priority = prioOptions.find((s) =>
		Array.from((s as HTMLSelectElement).options).some((o) => o.textContent === 'Urgent'),
	) as HTMLSelectElement;
	await user.selectOptions(priority, 'high');
	expect(priority.value).toBe('high');

	// Pick an assignee — now create is enabled.
	const assignee = prioOptions.find((s) =>
		Array.from((s as HTMLSelectElement).options).some((o) => o.textContent === 'Select assignee'),
	) as HTMLSelectElement;
	const firstAgentOption = Array.from(assignee.options).find((o) => o.value !== '');
	expect(firstAgentOption).toBeTruthy();
	await user.selectOptions(assignee, firstAgentOption?.value ?? '');
	await waitFor(() => expect(createBtn.disabled).toBe(false));

	await user.click(createBtn);

	// On success the dialog closes and we navigate to the created task page.
	await waitFor(() => expect(screen.queryByText('Create Task')).toBeNull(), { timeout: 15_000 });
	await waitFor(() => expect(router.state.location.pathname).toMatch(/\/tasks\/[a-z0-9-]+$/i), {
		timeout: 15_000,
	});
});

test('on the internal HQ project (no Captain) the assignee list collapses to the placeholder only', async () => {
	// On an internal project the dialog restricts selectable agents to the
	// Captain. HQ's roster is the CEO + Coach (no Captain), so the captain-only
	// filter resolves to an empty list — only the "Select assignee" placeholder
	// remains. This exercises the `isInternalProject` branch of selectableAgents.
	const ref = { slug: '' };
	const helpers = await renderApp({
		initialPath: '/',
		seed: async () => {
			const r = await getTestContext().db.query<{ slug: string }>(
				`SELECT slug FROM projects WHERE is_internal = true LIMIT 1`,
			);
			ref.slug = r.rows[0].slug;
		},
	});

	await helpers.router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: ref.slug },
	});

	const newBtn = await helpers.findByTestId('task-list-new-task', undefined, { timeout: 15_000 });
	await helpers.user.click(newBtn);

	const heading = await screen.findByText('Create Task');
	const dialog = heading.closest('[role="dialog"]') as HTMLElement;

	const assignee = within(dialog)
		.getAllByRole('combobox')
		.find((s) =>
			Array.from((s as HTMLSelectElement).options).some((o) => o.textContent === 'Select assignee'),
		) as HTMLSelectElement;

	// HQ has no Captain agent, so the internal-project filter yields zero
	// selectable agents — the placeholder is the only option.
	await waitFor(() => {
		const realOptions = Array.from(assignee.options).filter((o) => o.value !== '');
		expect(realOptions.length).toBe(0);
	});

	// Sanity: HQ truly has no captain-slugged agent (so the assertion above is the
	// empty branch, not a flake from agents still loading).
	const captainRows = await getTestContext().db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 JOIN projects p ON p.team_id = m.team_id
		 WHERE p.slug = $1 AND ma.slug = $2`,
		[ref.slug, CAPTAIN_AGENT_SLUG],
	);
	expect(captainRows.rows.length).toBe(0);
});
