import type { PGlite } from '@electric-sql/pglite';
import {
	deriveProjectStatus,
	ProjectStatus,
	type TaskProgressStatusRow,
	TaskStatus,
} from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, projectSlugFor } from './helpers/app';

function row(
	overrides: Partial<TaskProgressStatusRow> & Pick<TaskProgressStatusRow, 'id'>,
): TaskProgressStatusRow {
	return {
		status: TaskStatus.Backlog,
		parent_task_id: null,
		labels: [],
		has_active_run: false,
		last_run_status: null,
		...overrides,
	};
}

describe('deriveProjectStatus', () => {
	const planningId = 'planning-1';

	it('returns null when the execution scope is empty', () => {
		expect(
			deriveProjectStatus([row({ id: planningId, labels: ['planning'] })], planningId),
		).toBeNull();
	});

	it('returns completed when all execution-scope tasks are terminal', () => {
		const tasks = [
			row({ id: planningId, labels: ['planning'] }),
			row({ id: 'a', status: TaskStatus.Done }),
			row({ id: 'b', status: TaskStatus.Closed }),
		];
		expect(deriveProjectStatus(tasks, planningId)).toBe(ProjectStatus.Completed);
	});

	it('returns working when a scoped task has a queued run', () => {
		const tasks = [row({ id: 'a', status: TaskStatus.Backlog, has_active_run: true })];
		expect(deriveProjectStatus(tasks, null)).toBe(ProjectStatus.Working);
	});

	it('prefers working over error', () => {
		const tasks = [
			row({
				id: 'a',
				status: TaskStatus.InProgress,
				last_run_status: 'failed',
			}),
			row({ id: 'b', status: TaskStatus.InProgress, has_active_run: true }),
		];
		expect(deriveProjectStatus(tasks, null)).toBe(ProjectStatus.Working);
	});

	it('returns error only when every in_progress task has a failed last run', () => {
		const tasks = [
			row({ id: 'a', status: TaskStatus.InProgress, last_run_status: 'failed' }),
			row({ id: 'b', status: TaskStatus.InProgress, last_run_status: 'timed_out' }),
		];
		expect(deriveProjectStatus(tasks, null)).toBe(ProjectStatus.Error);

		const mixed = [
			row({ id: 'a', status: TaskStatus.InProgress, last_run_status: 'failed' }),
			row({ id: 'b', status: TaskStatus.InProgress, last_run_status: 'succeeded' }),
		];
		expect(deriveProjectStatus(mixed, null)).toBe(ProjectStatus.Idle);
	});

	it('does not return error when there are no in_progress tasks', () => {
		const tasks = [row({ id: 'a', status: TaskStatus.Backlog, last_run_status: 'failed' })];
		expect(deriveProjectStatus(tasks, null)).toBe(ProjectStatus.Idle);
	});

	it('returns idle as the fallback', () => {
		const tasks = [row({ id: 'a', status: TaskStatus.Backlog })];
		expect(deriveProjectStatus(tasks, null)).toBe(ProjectStatus.Idle);
	});
});

describe('project_status integration', () => {
	let db: PGlite;
	let app: Hono<Env>;
	let token: string;
	let teamId: string;
	let projectId: string;
	let projectSlug: string;
	let planningTaskId: string;
	let productLeadId: string;
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
			body: JSON.stringify({ name: 'Project Status Co', template_id: teamTemplateId }),
		});
		teamId = (await teamRes.json()).data.id;
		const internalProjectSlug = await projectSlugFor(db, teamId);

		const projectRes = await createTestProject(db, teamId, {
			name: 'Status Project',
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
		productLeadId = agents.find((a) => a.slug === 'product-lead')!.id;
		engineerId = agents.find((a) => a.slug === 'engineer')!.id;

		await db.query(
			`INSERT INTO documents (project_id, team_id, type, slug, content)
			 VALUES ($1, $2, 'project_doc', 'prd.md', '# PRD')`,
			[projectId, teamId],
		);
		const prdRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'PRD',
				assignee_id: productLeadId,
				parent_task_id: planningTaskId,
			}),
		});
		const prdId = (await prdRes.json()).data.id;
		await db.query('UPDATE tasks SET status = $1::task_status WHERE id = $2', [
			TaskStatus.Done,
			prdId,
		]);
		await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Execution epic',
				assignee_id: engineerId,
			}),
		});

		await db.query('UPDATE tasks SET status = $1::task_status WHERE id = $2', [
			TaskStatus.Closed,
			planningTaskId,
		]);
	});

	afterAll(async () => {
		await safeClose(db);
	});

	it('returns idle when execution work is waiting via the API', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/tasks/progress-summary`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.project_status).toBe(ProjectStatus.Idle);
	});
});
