import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { type SeededTask, seedProject, seedTask, seedWorkspace } from './helpers/seed';

// hire_proposal comments are `action` comments posted by create_hire_proposal /
// the onboard endpoint (not the comments API), so seed them with a direct insert.
// `chosen_option` is null while pending and set once the approval resolves.
interface Chosen {
	status: 'approved' | 'denied';
	member_agent_slug?: string;
	resolution_note?: string;
}

async function seedHireProposal(
	task: SeededTask,
	input: { approvalId: string; title: string; roleDescription?: string; chosen?: Chosen },
): Promise<void> {
	const { db } = getTestContext();
	const content = {
		kind: 'hire_proposal',
		approval_id: input.approvalId,
		title: input.title,
		slug: input.title.toLowerCase().replace(/\s+/g, '-'),
		role_description: input.roleDescription ?? '',
		monthly_budget_cents: 3000,
		heartbeat_interval_min: 60,
		touches_code: false,
	};
	await db.query(
		`INSERT INTO task_comments (task_id, content_type, content, chosen_option)
		 VALUES ($1, 'action'::comment_content_type, $2::jsonb, $3::jsonb)`,
		[task.id, JSON.stringify(content), input.chosen ? JSON.stringify(input.chosen) : null],
	);
}

async function renderTaskWithHireProposal(chosen?: Chosen) {
	const seeded = { projectSlug: '', taskId: '' };
	const helpers = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Hire UI Project' });
			const task = await seedTask(ws, project, { title: 'Onboard new agent' });
			await seedHireProposal(task, {
				approvalId: '11111111-1111-1111-1111-111111111111',
				title: 'Marketing Lead',
				roleDescription: 'Leads brand and campaigns',
				chosen,
			});
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
		},
	});
	await helpers.router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});
	return helpers;
}

test('pending hire proposal shows the role and only an Edit & review action', async () => {
	const { findByTestId, findByText, queryByRole } = await renderTaskWithHireProposal();

	const card = await findByTestId('hire-proposal-pending', undefined, { timeout: 15_000 });
	expect(card.textContent).toContain('Marketing Lead');
	await findByText(/Leads brand and campaigns/);

	// The only action is "Edit & review" (opens the hire page); no inline approve/deny.
	const edit = await findByTestId('hire-proposal-edit');
	expect(edit.textContent).toContain('Edit & review');
	expect(queryByRole('button', { name: 'Approve' })).toBeNull();
	expect(queryByRole('button', { name: 'Deny' })).toBeNull();
});

test('the Edit & review link points at the hire page for the proposal', async () => {
	const { findByTestId } = await renderTaskWithHireProposal();
	await findByTestId('hire-proposal-pending', undefined, { timeout: 15_000 });
	const edit = await findByTestId('hire-proposal-edit');
	const link = edit.closest('a');
	expect(link?.getAttribute('href')).toContain('/agents/hire');
	expect(link?.getAttribute('href')).toContain('approvalId=11111111-1111-1111-1111-111111111111');
});

test('approved hire proposal renders the hired state', async () => {
	const { findByTestId } = await renderTaskWithHireProposal({
		status: 'approved',
		member_agent_slug: 'marketing-lead',
	});
	const card = await findByTestId('hire-proposal-approved', undefined, { timeout: 15_000 });
	expect(card.textContent).toContain('Hired');
	expect(card.textContent).toContain('Marketing Lead');
});

test('denied hire proposal renders the denied state with the note', async () => {
	const { findByTestId } = await renderTaskWithHireProposal({
		status: 'denied',
		resolution_note: 'Not needed this quarter',
	});
	const card = await findByTestId('hire-proposal-denied', undefined, { timeout: 15_000 });
	expect(card.textContent).toContain('denied');
	expect(card.textContent).toContain('Not needed this quarter');
});
