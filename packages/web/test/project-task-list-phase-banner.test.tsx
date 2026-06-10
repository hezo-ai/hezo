import { TaskStatus } from '@hezo/shared';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { type SeededWorkspace, seedProject, seedWorkspace } from './helpers/seed';

async function planningTaskId(ws: SeededWorkspace, projectId: string): Promise<string> {
	const { db } = getTestContext();
	const row = await db.query<{ id: string }>(
		`SELECT id FROM tasks WHERE project_id = $1 AND labels @> '["planning"]'::jsonb LIMIT 1`,
		[projectId],
	);
	const id = row.rows[0]?.id;
	if (!id) throw new Error('planningTaskId: no planning epic');
	return id;
}

async function insertCoherenceTask(
	ws: SeededWorkspace,
	projectId: string,
	status: string,
): Promise<void> {
	const { db } = getTestContext();
	const ceo = await db.query<{ id: string }>(
		`SELECT id FROM member_agents WHERE slug = 'ceo' LIMIT 1`,
	);
	const ceoId = ceo.rows[0]?.id;
	if (!ceoId) throw new Error('insertCoherenceTask: CEO missing');

	const numberRow = await db.query<{ n: number }>(
		`SELECT COALESCE(MAX(number), 0) + 1 AS n FROM tasks WHERE project_id = $1`,
		[projectId],
	);
	const number = numberRow.rows[0].n;
	const identifier = `PP-${number}`;

	await db.query(
		`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier,
		                     title, description, status, priority, labels)
		 VALUES ($1, $2, $3, $4, $5, $6, '', $7::task_status, $8::task_priority, $9::jsonb)`,
		[
			ws.team.id,
			projectId,
			ceoId,
			number,
			identifier,
			'Review team coherence after roster change',
			status,
			'high',
			JSON.stringify(['internal', 'team-coherence-review']),
		],
	);
}

async function patchStatus(ws: SeededWorkspace, taskId: string, status: string) {
	const { apiBase } = getTestContext();
	const res = await apiBase(`/api/projects/${ws.internalSlug}/tasks/${taskId}`, {
		method: 'PATCH',
		headers: ws.headers,
		body: JSON.stringify({ status }),
	});
	if (!res.ok) throw new Error(`patchStatus failed: ${res.status} ${await res.text()}`);
}

test('tasks page shows onboarding banner while coherence review is open', async () => {
	let projectSlug = '';

	const { findByTestId, queryByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Onboarding Project' });
			projectSlug = project.slug;
			await insertCoherenceTask(ws, project.id, TaskStatus.InProgress);
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: projectSlug },
	});

	await findByTestId('project-task-list-phase-banner-onboarding', undefined, { timeout: 10_000 });
	expect(queryByTestId('project-task-list-phase-banner-planning')).toBeNull();
});

test('tasks page shows planning banner when the draft execution plan is in progress', async () => {
	let projectSlug = '';

	const { findByTestId, findByText, queryByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Planning Phase Project' });
			projectSlug = project.slug;
			await insertCoherenceTask(ws, project.id, TaskStatus.Done);
			const planningId = await planningTaskId(ws, project.id);
			await patchStatus(ws, planningId, TaskStatus.InProgress);
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: projectSlug },
	});

	await findByTestId('project-task-list-phase-banner-planning', undefined, { timeout: 10_000 });
	await findByTestId('project-status-idle');
	await findByText('Planning Phase Project - Planning phase');
	expect(queryByTestId('project-task-list-phase-banner-onboarding')).toBeNull();
});
