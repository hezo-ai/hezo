import {
	insertTaskSuggestionApproval,
	insertTaskSuggestionComment,
} from '@hezo/server/src/services/task-suggestion';
import { fireEvent, waitFor, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { seedProject, seedTask, seedWorkspace } from './helpers/seed';

// Component tier (happy-dom): the card is a comment on a task page, driven
// against the real server, so a repeat choice and an approval land in the
// database the way they do in production.

interface Seeded {
	projectSlug: string;
	projectId: string;
	taskId: string;
	approvalId: string;
}

async function renderSuggestionCard(input: {
	kind: string;
	title: string;
	cadence?: 'daily' | 'weekly' | 'monthly';
}) {
	const seeded: Seeded = { projectSlug: '', projectId: '', taskId: '', approvalId: '' };
	const helpers = await renderApp({
		initialPath: '/',
		seed: async () => {
			const { db } = getTestContext();
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Stock Watch' });
			const host = await seedTask(ws, project, { title: 'Suggest starter tasks' });
			const payload = {
				project_id: project.id,
				kind: input.kind as 'recurring',
				title: input.title,
				description: 'Why this helps the project.',
				suggested_cadence: input.cadence ?? null,
				cadence: input.cadence ?? null,
				task_id: host.id,
			};
			const approval = await insertTaskSuggestionApproval(db, ws.team.id, payload, null);
			await insertTaskSuggestionComment(db, {
				taskId: host.id,
				approvalId: approval.id as string,
				payload: payload as unknown as Record<string, unknown>,
				teamId: ws.team.id,
				projectId: project.id,
			});
			Object.assign(seeded, {
				projectSlug: project.slug,
				projectId: project.id,
				taskId: host.identifier.toLowerCase(),
				approvalId: approval.id as string,
			});
		},
	});
	await helpers.router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});
	return { ...helpers, seeded };
}

async function approvalPayload(approvalId: string): Promise<Record<string, unknown>> {
	const { db } = getTestContext();
	const r = await db.query<{ payload: Record<string, unknown> }>(
		'SELECT payload FROM approvals WHERE id = $1',
		[approvalId],
	);
	return r.rows[0].payload;
}

test('a repeating suggestion shows its kind and the repeat choice, and saves a new choice', async () => {
	const { findByTestId, seeded } = await renderSuggestionCard({
		kind: 'recurring',
		title: 'Catch up on market news',
		cadence: 'weekly',
	});

	const card = await findByTestId('task-suggestion-pending', undefined, { timeout: 15_000 });
	expect(card.textContent).toContain('Suggested task: Catch up on market news');
	expect(card.textContent).toContain('Why this helps the project.');
	expect(within(card).getByTestId('task-suggestion-kind').textContent).toBe('Kind: Repeating work');

	const repeats = within(card).getByTestId('task-suggestion-repeats');
	const weekly = within(repeats).getByRole('button', { name: 'Weekly' });
	expect(weekly.getAttribute('aria-pressed')).toBe('true');
	expect(within(repeats).getByRole('button', { name: 'Just once' })).toBeTruthy();

	fireEvent.click(within(repeats).getByRole('button', { name: 'Monthly' }));
	await waitFor(async () => {
		expect((await approvalPayload(seeded.approvalId)).cadence).toBe('monthly');
	});
	await waitFor(() => {
		const monthly = within(within(card).getByTestId('task-suggestion-repeats')).getByRole(
			'button',
			{ name: 'Monthly' },
		);
		expect(monthly.getAttribute('aria-pressed')).toBe('true');
	});
});

test('a suggestion that does not repeat shows no repeat choice', async () => {
	const { findByTestId } = await renderSuggestionCard({
		kind: 'connection',
		title: 'Connect your online broker',
	});

	const card = await findByTestId('task-suggestion-pending', undefined, { timeout: 15_000 });
	expect(within(card).getByTestId('task-suggestion-kind').textContent).toBe('Kind: Connection');
	expect(within(card).queryByTestId('task-suggestion-repeats')).toBeNull();
	expect(card.textContent).not.toContain('Just once');
});

test('Approve creates the task and the card links to it', async () => {
	const { findByTestId, seeded } = await renderSuggestionCard({
		kind: 'report',
		title: 'Weekly portfolio report',
		cadence: 'weekly',
	});

	await findByTestId('task-suggestion-pending', undefined, { timeout: 15_000 });
	fireEvent.click(await findByTestId('task-suggestion-approve'));

	const approved = await findByTestId('task-suggestion-approved', undefined, { timeout: 15_000 });
	const { db } = getTestContext();
	const created = await db.query<{ identifier: string; rules: string | null }>(
		`SELECT identifier, rules FROM tasks WHERE project_id = $1 AND title = $2`,
		[seeded.projectId, 'Weekly portfolio report'],
	);
	expect(created.rows).toHaveLength(1);
	expect(created.rows[0].rules).toContain('Repeats weekly');
	expect(approved.textContent).toContain(`Task created: ${created.rows[0].identifier}`);
	const link = within(approved).getByRole('link', { name: created.rows[0].identifier });
	expect(link.getAttribute('href')).toContain(created.rows[0].identifier.toLowerCase());
	expect(within(approved).getByTestId('task-suggestion-approved-notes').textContent).toContain(
		'Repeats weekly',
	);
});

test('Deny dismisses the suggestion and creates no task', async () => {
	const { findByTestId, seeded } = await renderSuggestionCard({
		kind: 'deliverable',
		title: 'Draft the first stock report',
	});

	await findByTestId('task-suggestion-pending', undefined, { timeout: 15_000 });
	fireEvent.click(await findByTestId('task-suggestion-deny'));

	const denied = await findByTestId('task-suggestion-denied', undefined, { timeout: 15_000 });
	expect(denied.textContent).toContain('Task suggestion Draft the first stock report was denied');
	const { db } = getTestContext();
	const created = await db.query('SELECT 1 FROM tasks WHERE project_id = $1 AND title = $2', [
		seeded.projectId,
		'Draft the first stock report',
	]);
	expect(created.rows).toHaveLength(0);
});
