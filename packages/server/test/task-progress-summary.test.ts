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
let engineerId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	app = ctx.app;
	token = ctx.token;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const teamTemplateId = (await typesRes.json()).data.find(
		(t: { name: string }) => t.name === 'Startup',
	).id;

	const teamRes = await app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Progress Summary Co', template_id: teamTemplateId }),
	});
	teamId = (await teamRes.json()).data.id;
	const internalProjectSlug = await projectSlugFor(db, teamId);

	const projectRes = await createTestProject(db, teamId, {
		name: 'Progress Project',
		description: 'Test project.',
	});
	const projectData = (await projectRes.json()).data;
	projectId = projectData.id;
	projectSlug = projectData.slug;
	planningTaskId = projectData.planning_task_id!;

	const agentsRes = await app.request(`/api/projects/${internalProjectSlug}/agents`, {
		headers: authHeader(token),
	});
	const agents = (await agentsRes.json()).data as Array<{ id: string; slug: string }>;
	engineerId = agents.find((a) => a.slug === 'engineer')!.id;
});

afterAll(async () => {
	await safeClose(db);
});

async function getSummary() {
	const res = await app.request(`/api/projects/${projectSlug}/tasks/progress-summary`, {
		headers: authHeader(token),
	});
	expect(res.status).toBe(200);
	return (await res.json()).data;
}

async function createTask(
	title: string,
	assigneeId: string,
	parentTaskId?: string,
): Promise<{ id: string; identifier: string }> {
	const res = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			project_id: projectId,
			title,
			assignee_id: assigneeId,
			...(parentTaskId ? { parent_task_id: parentTaskId } : {}),
		}),
	});
	expect(res.status).toBe(201);
	return (await res.json()).data;
}

describe('GET /projects/:projectId/tasks/progress-summary', () => {
	it('returns not ready while the planning ticket is open', async () => {
		const summary = await getSummary();
		expect(summary.planning_complete).toBe(false);
		expect(summary.total).toBe(0);
		expect(summary.percent_complete).toBe(0);
		expect(summary.project_status).toBeNull();
		expect(summary.phase_banner).toBeNull();
	});

	it('counts execution-scope tasks once the planning ticket is closed', async () => {
		await db.query('UPDATE tasks SET status = $1::task_status WHERE id = $2', [
			TaskStatus.Closed,
			planningTaskId,
		]);

		const exec = await createTask('Build feature', engineerId);
		const sub = await createTask('Sub-task', engineerId, exec.id);
		await db.query('UPDATE tasks SET status = $1::task_status WHERE id = $2', [
			TaskStatus.Done,
			exec.id,
		]);
		await db.query('UPDATE tasks SET status = $1::task_status WHERE id = $2', [
			TaskStatus.InProgress,
			sub.id,
		]);

		const summary = await getSummary();
		expect(summary.planning_complete).toBe(true);
		expect(summary.total).toBe(2);
		expect(summary.complete).toBe(1);
		expect(summary.in_progress).toBe(1);
		expect(summary.not_done).toBe(0);
		expect(summary.percent_complete).toBe(50);
		expect(summary.by_status.done).toBe(1);
		expect(summary.by_status.in_progress).toBe(1);
	});

	it('excludes planning epic and its sub-tasks from totals', async () => {
		const before = await getSummary();
		const research = await createTask('Research', engineerId, planningTaskId);
		await db.query('UPDATE tasks SET status = $1::task_status WHERE id = $2', [
			TaskStatus.Done,
			research.id,
		]);

		const after = await getSummary();
		expect(after.total).toBe(before.total);
	});
});

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

describe('GET /projects/:projectId/tasks/progress-summary phase_banner', () => {
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

	it('returns onboarding while the coherence review ticket is open', async () => {
		await insertCoherenceTask(TaskStatus.InProgress);

		const summary = await getSummary();
		expect(summary.phase_banner).toBe(ProjectTaskListPhaseBanner.Onboarding);
	});

	it('shows no banner when coherence is done and the planning ticket is in progress', async () => {
		await insertCoherenceTask(TaskStatus.Done);
		await db.query('UPDATE tasks SET status = $1::task_status WHERE id = $2', [
			TaskStatus.InProgress,
			planningTaskId,
		]);

		const summary = await getSummary();
		expect(summary.phase_banner).toBeNull();
		expect(summary.project_status).toBeNull();
	});

	it('shows onboarding while coherence is open even if planning is in progress', async () => {
		await insertCoherenceTask(TaskStatus.InProgress);
		await db.query('UPDATE tasks SET status = $1::task_status WHERE id = $2', [
			TaskStatus.InProgress,
			planningTaskId,
		]);

		const summary = await getSummary();
		expect(summary.phase_banner).toBe(ProjectTaskListPhaseBanner.Onboarding);
	});
});
