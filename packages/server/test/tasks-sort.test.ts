import type { PGlite } from '@electric-sql/pglite';
import { TaskPriority, TaskStatus } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject } from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let teamId: string;
let projectId: string;
let projectSlug: string;
let agentId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const teamRes = await app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Task Sort Co' }),
	});
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Sort Project',
		description: 'Test project.',
	});
	const projectData = (await projectRes.json()).data;
	projectId = projectData.id;
	projectSlug = projectData.slug;

	const agentRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Worker' }),
	});
	agentId = (await agentRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

async function insertTask(
	title: string,
	opts: { priority?: string; status?: string } = {},
): Promise<{ id: string; identifier: string; number: number }> {
	const meta = await db.query<{ task_prefix: string; number: number }>(
		`SELECT p.task_prefix, next_project_task_number(p.id) AS number
		 FROM projects p WHERE p.id = $1`,
		[projectId],
	);
	const n = meta.rows[0].number;
	const priority = opts.priority ?? TaskPriority.Medium;
	const status = opts.status ?? TaskStatus.Backlog;
	const res = await db.query<{ id: string; identifier: string; number: number }>(
		`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier, title, status, priority, labels)
		 VALUES ($1, $2, $3, $4, $5, $6, $7::task_status, $8::task_priority, '[]'::jsonb)
		 RETURNING id, identifier, number`,
		[teamId, projectId, agentId, n, `${meta.rows[0].task_prefix}-${n}`, title, status, priority],
	);
	return res.rows[0];
}

async function listIds(sort?: string): Promise<string[]> {
	const qs = sort ? `?sort=${encodeURIComponent(sort)}&per_page=50` : '?per_page=50';
	const res = await app.request(`/api/projects/${projectSlug}/tasks${qs}`, {
		headers: authHeader(token),
	});
	expect(res.status).toBe(200);
	const rows = (await res.json()).data as Array<{ id: string; title: string }>;
	return rows.map((r) => r.id);
}

describe('GET /projects/:projectId/tasks sort=work_order', () => {
	it('defaults to work order when sort is omitted', async () => {
		const first = await insertTask('First ticket');
		const second = await insertTask('Second ticket');
		const ids = await listIds();
		const firstIdx = ids.indexOf(first.id);
		const secondIdx = ids.indexOf(second.id);
		expect(firstIdx).toBeGreaterThanOrEqual(0);
		expect(secondIdx).toBeGreaterThan(firstIdx);
	});

	it('lists ready tasks before dependency-gated tasks', async () => {
		const blocker = await insertTask('Blocker');
		const gated = await insertTask('Gated');
		await db.query(`INSERT INTO task_dependencies (task_id, blocked_by_task_id) VALUES ($1, $2)`, [
			gated.id,
			blocker.id,
		]);

		const ids = await listIds('work_order:asc');
		expect(ids.indexOf(blocker.id)).toBeLessThan(ids.indexOf(gated.id));
	});

	it('ranks urgent ahead of medium among ready tasks', async () => {
		const medium = await insertTask('Medium ticket', { priority: TaskPriority.Medium });
		const urgent = await insertTask('Urgent ticket', { priority: TaskPriority.Urgent });

		const ids = await listIds('work_order:asc');
		expect(ids.indexOf(urgent.id)).toBeLessThan(ids.indexOf(medium.id));
	});
});
