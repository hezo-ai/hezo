import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject } from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let teamId: string;

const VALID_DESCRIPTION = 'A backend API that serves authenticated requests for the main app.';

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const teamRes = await app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Project Test Co' }),
	});
	teamId = (await teamRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('projects CRUD', () => {
	it('creates a project with description and opens a planning task for the Captain', async () => {
		const res = await createTestProject(db, teamId, {
			name: 'Backend API',
			description: VALID_DESCRIPTION,
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.name).toBe('Backend API');
		expect(body.data.slug).toBe('backend-api');
		expect(body.data.team_id).toBe(teamId);
		expect(body.data.description).toBe(VALID_DESCRIPTION);

		const captainResult = await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = 'captain' LIMIT 1`,
			[teamId],
		);
		const captainId = captainResult.rows[0]?.id;
		expect(captainId).toBeDefined();

		const taskResult = await db.query<{
			id: string;
			title: string;
			description: string;
			assignee_id: string;
			status: string;
			priority: string;
			labels: string[] | string;
		}>(
			'SELECT id, title, description, assignee_id, status, priority, labels FROM tasks WHERE project_id = $1',
			[body.data.id],
		);
		expect(taskResult.rows.length).toBe(1);
		const task = taskResult.rows[0];
		expect(task.assignee_id).toBe(captainId);
		expect(task.status).toBe('backlog');
		expect(task.priority).toBe('high');
		expect(task.title).toContain('Draft execution plan');
		expect(task.description).toContain(VALID_DESCRIPTION);
		const labels = typeof task.labels === 'string' ? JSON.parse(task.labels) : task.labels;
		expect(labels).toContain('planning');

		expect(body.data.planning_task_id).toBe(task.id);
	});

	it('defaults docker_base_image to the bundled agent-base image when not supplied', async () => {
		const res = await createTestProject(db, teamId, {
			name: 'Default Image Project',
			description: VALID_DESCRIPTION,
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.docker_base_image).toBe('hezo/agent-base:latest');
	});

	it('honors an explicit docker_base_image from the request body', async () => {
		const res = await createTestProject(db, teamId, {
			name: 'Custom Image Project',
			description: VALID_DESCRIPTION,
			docker_base_image: 'python:3.12-slim',
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.docker_base_image).toBe('python:3.12-slim');
	});

	it('rejects a missing description at the POST /projects route', async () => {
		const res = await app.request(`/api/teams/${teamId}/projects`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Missing description' }),
		});
		expect(res.status).toBe(400);
	});

	it('rejects a blank description at the POST /projects route', async () => {
		const res = await app.request(`/api/teams/${teamId}/projects`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Blank description', description: '   ' }),
		});
		expect(res.status).toBe(400);
	});

	it('lists projects with counts', async () => {
		const res = await app.request(`/api/teams/${teamId}/projects`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBeGreaterThanOrEqual(1);
		expect(body.data[0]).toHaveProperty('repo_count');
		expect(body.data[0]).toHaveProperty('open_task_count');
	});

	it('gets a project by id with repos', async () => {
		const listRes = await app.request(`/api/teams/${teamId}/projects`, {
			headers: authHeader(token),
		});
		const project = (await listRes.json()).data[0];

		const res = await app.request(`/api/teams/${teamId}/projects/${project.id}`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data).toHaveProperty('repos');
	});

	it('updates a project', async () => {
		const listRes = await app.request(`/api/teams/${teamId}/projects`, {
			headers: authHeader(token),
		});
		const project = (await listRes.json()).data.find(
			(p: { slug: string }) => p.slug === 'backend-api',
		);

		const res = await app.request(`/api/teams/${teamId}/projects/${project.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ description: 'Updated description body.' }),
		});
		expect(res.status).toBe(200);
		const data = (await res.json()).data;
		expect(data.description).toBe('Updated description body.');
	});

	it('generates unique slugs for same-named projects', async () => {
		const res1 = await createTestProject(db, teamId, {
			name: 'Same Name',
			description: VALID_DESCRIPTION,
		});
		const res2 = await createTestProject(db, teamId, {
			name: 'Same Name',
			description: VALID_DESCRIPTION,
		});
		expect(res1.status).toBe(201);
		expect(res2.status).toBe(201);
		const slug1 = (await res1.json()).data.slug;
		const slug2 = (await res2.json()).data.slug;
		expect(slug1).toBe('same-name');
		expect(slug2).toBe('same-name-2');
	});

	it('deletes a project with no open tasks', async () => {
		const createRes = await createTestProject(db, teamId, {
			name: 'Temp Project',
			description: VALID_DESCRIPTION,
		});
		const project = (await createRes.json()).data;

		// The auto-created planning task is open; cancel it so delete can proceed.
		await db.query(`UPDATE tasks SET status = 'cancelled'::task_status WHERE project_id = $1`, [
			project.id,
		]);

		const res = await app.request(`/api/teams/${teamId}/projects/${project.id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
	});
});

describe('initial PRD upload', () => {
	it('saves initial_prd as a project doc and references it in the planning task', async () => {
		const prdContent = '# My Product\n\n## Overview\nA tool for managing widgets.';
		const res = await createTestProject(db, teamId, {
			name: 'PRD Upload Project',
			description: VALID_DESCRIPTION,
			initial_prd: prdContent,
		});
		expect(res.status).toBe(201);
		const project = (await res.json()).data;

		const docResult = await db.query<{ filename: string; content: string }>(
			"SELECT slug AS filename, content FROM documents WHERE type = 'project_doc' AND project_id = $1 AND slug = $2",
			[project.id, 'initial-prd.md'],
		);
		expect(docResult.rows.length).toBe(1);
		expect(docResult.rows[0].content).toBe(prdContent);

		const taskResult = await db.query<{ description: string }>(
			'SELECT description FROM tasks WHERE project_id = $1',
			[project.id],
		);
		expect(taskResult.rows[0].description).toContain('initial-prd.md');
		expect(taskResult.rows[0].description).toContain('Researcher');
		expect(taskResult.rows[0].description).toContain('Product Lead');
	});

	it('does not create initial-prd.md when initial_prd is not provided', async () => {
		const res = await createTestProject(db, teamId, {
			name: 'No PRD Project',
			description: VALID_DESCRIPTION,
		});
		expect(res.status).toBe(201);
		const project = (await res.json()).data;

		const docResult = await db.query(
			"SELECT 1 FROM documents WHERE type = 'project_doc' AND project_id = $1 AND slug = $2",
			[project.id, 'initial-prd.md'],
		);
		expect(docResult.rows.length).toBe(0);

		const taskResult = await db.query<{ description: string }>(
			'SELECT description FROM tasks WHERE project_id = $1',
			[project.id],
		);
		expect(taskResult.rows[0].description).not.toContain('initial-prd.md');
	});

	it('ignores empty/whitespace-only initial_prd', async () => {
		const res = await createTestProject(db, teamId, {
			name: 'Empty PRD Project',
			description: VALID_DESCRIPTION,
			initial_prd: '   ',
		});
		expect(res.status).toBe(201);
		const project = (await res.json()).data;

		const docResult = await db.query(
			"SELECT 1 FROM documents WHERE type = 'project_doc' AND project_id = $1 AND slug = $2",
			[project.id, 'initial-prd.md'],
		);
		expect(docResult.rows.length).toBe(0);
	});
});

describe('slug-based project access', () => {
	it('gets a project by slug', async () => {
		const listRes = await app.request(`/api/teams/${teamId}/projects`, {
			headers: authHeader(token),
		});
		const project = (await listRes.json()).data.find(
			(p: { slug: string }) => p.slug === 'backend-api',
		);

		const res = await app.request(`/api/teams/${teamId}/projects/${project.slug}`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.id).toBe(project.id);
		expect(body.data.slug).toBe('backend-api');
	});

	it('returns 404 for non-existent project slug', async () => {
		const res = await app.request(`/api/teams/${teamId}/projects/nonexistent-slug`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(404);
	});

	it('accesses team by slug and project by slug together', async () => {
		const teamsRes = await app.request('/api/teams', {
			headers: authHeader(token),
		});
		const team = (await teamsRes.json()).data.find(
			(c: { slug: string }) => c.slug === 'project-test-co',
		);

		const res = await app.request(`/api/teams/${team.slug}/projects/backend-api`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.name).toBe('Backend API');
	});

	it('updates a project by slug', async () => {
		const res = await app.request(`/api/teams/${teamId}/projects/backend-api`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ description: 'Slug-based update' }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.description).toBe('Slug-based update');
	});
});
