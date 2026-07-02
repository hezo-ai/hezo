import type { PGlite } from '@electric-sql/pglite';
import { ProjectTaskListPhaseBanner, TaskStatus } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { allocateTaskIdentifier } from '../src/lib/task-identifier';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	instanceCeoId,
	projectSlugFor,
} from './helpers/app';

let db: PGlite;
let app: Hono<Env>;
let token: string;
let teamId: string;
let projectId: string;
let projectSlug: string;
let planningTaskId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	app = ctx.app;
	token = ctx.token;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const teamTemplateId = (await typesRes.json()).data.find(
		(t: { name: string }) => t.name === 'Startup',
	).id;

	const teamRes = await createTestTeam(db, {
		name: 'Phase Banner Co',
		template_id: teamTemplateId,
	});
	teamId = (await teamRes.json()).data.id;
	await projectSlugFor(db, teamId);

	const projectRes = await createTestProject(db, teamId, {
		name: 'Phase Banner Project',
		description: 'Test project.',
	});
	const projectData = (await projectRes.json()).data;
	projectId = projectData.id;
	projectSlug = projectData.slug;
	planningTaskId = projectData.planning_task_id!;
});

afterAll(async () => {
	await safeClose(db);
});

async function getPhaseBanner() {
	const res = await app.request(`/api/projects/${projectSlug}/tasks/phase-banner`, {
		headers: authHeader(token),
	});
	expect(res.status).toBe(200);
	return (await res.json()).data;
}

async function insertCoherenceTask(status: string): Promise<string> {
	const ceoId = await instanceCeoId(db);
	const { number, identifier } = await allocateTaskIdentifier(db, projectId);
	const result = await db.query<{ id: string }>(
		`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier,
		                     title, description, status, priority, labels)
		 VALUES ($1, $2, $3, $4, $5, $6, '', $7::task_status, $8::task_priority, $9::jsonb)
		 RETURNING id`,
		[
			teamId,
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
	return result.rows[0].id;
}

describe('GET /projects/:projectId/tasks/phase-banner', () => {
	beforeEach(async () => {
		await db.query(
			`DELETE FROM tasks
			 WHERE project_id = $1 AND labels @> '["team-coherence-review"]'::jsonb`,
			[projectId],
		);
		await db.query('UPDATE tasks SET status = $1::task_status WHERE id = $2', [
			TaskStatus.Backlog,
			planningTaskId,
		]);
	});

	it('shows no banner for a project with no open coherence-review task', async () => {
		const state = await getPhaseBanner();
		expect(state.phase_banner).toBeNull();
	});

	it('returns onboarding while the coherence review ticket is open', async () => {
		await insertCoherenceTask(TaskStatus.InProgress);

		const state = await getPhaseBanner();
		expect(state.phase_banner).toBe(ProjectTaskListPhaseBanner.Onboarding);
	});

	it('shows no banner once the coherence review ticket is done', async () => {
		await insertCoherenceTask(TaskStatus.Done);
		await db.query('UPDATE tasks SET status = $1::task_status WHERE id = $2', [
			TaskStatus.InProgress,
			planningTaskId,
		]);

		const state = await getPhaseBanner();
		expect(state.phase_banner).toBeNull();
	});

	it('shows onboarding while coherence is open even if planning is in progress', async () => {
		await insertCoherenceTask(TaskStatus.InProgress);
		await db.query('UPDATE tasks SET status = $1::task_status WHERE id = $2', [
			TaskStatus.InProgress,
			planningTaskId,
		]);

		const state = await getPhaseBanner();
		expect(state.phase_banner).toBe(ProjectTaskListPhaseBanner.Onboarding);
	});
});
