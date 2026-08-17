import { QueuedRunReason } from '@hezo/shared';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { seedProject, seedRunningAgent, seedTask, seedWorkspace } from './helpers/seed';

// "Queued" on its own reads like something is stuck. The reason says which wait
// it is, and the info icon says what that means and whether it needs the
// operator - the two reasons differ on that second point.

/** Park the task's run in `queued` with `reason`, as the runner would. */
async function parkRun(reason: string): Promise<void> {
	const { db } = getTestContext();
	await db.query(
		`UPDATE heartbeat_runs SET status = 'queued'::heartbeat_run_status,
		        started_at = NULL, queued_reason = $1`,
		[reason],
	);
}

async function renderQueued(reason: string) {
	const seeded = { projectSlug: '', taskId: '' };
	const app = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Queued Project' });
			const task = await seedTask(ws, project, { title: 'Queued Task' });
			await seedRunningAgent(ws, task, ws.agents[0].id);
			await parkRun(reason);
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
		},
	});
	await app.router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});
	return app;
}

test('a credential wait explains itself, and says how to run more in parallel', async () => {
	const { findByTestId } = await renderQueued(QueuedRunReason.CredentialSerialized);

	const working = await findByTestId('run-comment-working', undefined, { timeout: 20_000 });
	expect(working.textContent).toContain('is queued');
	expect(working.textContent).toContain('waiting for prior run on this credential');

	const help = await findByTestId('queued-reason-help');
	expect(help.getAttribute('aria-label')).toBe('waiting for prior run on this credential');
});

test('a capacity wait explains itself too', async () => {
	const { findByTestId } = await renderQueued(QueuedRunReason.CapacityPark);

	const working = await findByTestId('run-comment-working', undefined, { timeout: 20_000 });
	expect(working.textContent).toContain('waiting for container capacity');
	expect(await findByTestId('queued-reason-help')).toBeTruthy();
});

// An older row, or a newer server, must still render its reason rather than
// leaving the row saying only "queued".
test('a reason this build does not recognise still renders, without an icon', async () => {
	const { findByTestId, queryByTestId } = await renderQueued('waiting for something new');

	const working = await findByTestId('run-comment-working', undefined, { timeout: 20_000 });
	expect(working.textContent).toContain('waiting for something new');
	expect(queryByTestId('queued-reason-help')).toBeNull();
});
