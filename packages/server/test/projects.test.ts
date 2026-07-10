import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestTeam } from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: MasterKeyManager;
let projectSlug: string;
let teamId: string;
let teamSlug: string;

const VALID_DESCRIPTION = 'A backend API that serves authenticated requests for the main app.';

// Under 1:1, each project owns its own team, so creation goes through the direct
// `POST /api/projects` API (which provisions the team + project together).
async function createProject(opts: {
	name: string;
	description?: string;
	template_id?: string;
	task_prefix?: string;
	initial_project_plan?: string;
	docker_base_image?: string;
}): Promise<{ status: number; json: () => Promise<{ data: Record<string, unknown> }> }> {
	const res = await app.request('/api/projects', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ description: VALID_DESCRIPTION, ...opts }),
	});
	return {
		status: res.status,
		json: () => res.json() as Promise<{ data: Record<string, unknown> }>,
	};
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const teamRes = await createTestTeam(db, { name: 'Project Test Co' });
	const teamData = (await teamRes.json()).data;
	teamId = teamData.id;
	teamSlug = teamData.slug;
});

async function listTeamProjects(): Promise<
	Array<{ id: string; slug: string; name: string; team_id: string; team_slug: string }>
> {
	const res = await app.request('/api/projects', { headers: authHeader(token) });
	const all = (await res.json()).data as Array<{
		id: string;
		slug: string;
		name: string;
		team_id: string;
		team_slug: string;
		is_internal: boolean;
	}>;
	// Each project owns its own team (1:1); list every user-facing project.
	return all.filter((p) => !p.is_internal);
}

afterAll(async () => {
	await safeClose(db);
});

describe('projects CRUD', () => {
	it('creates a project with description and opens a planning task for the Captain', async () => {
		const res = await createProject({
			name: 'Backend API',
			description: VALID_DESCRIPTION,
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.name).toBe('Backend API');
		expect(body.data.slug).toBe('backend-api');
		expect(body.data.team_id).toBeDefined();
		expect(body.data.description).toBe(VALID_DESCRIPTION);

		const captainResult = await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = 'captain' LIMIT 1`,
			[body.data.team_id],
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
			`SELECT id, title, description, assignee_id, status, priority, labels FROM tasks
			 WHERE project_id = $1 AND labels @> '["planning"]'::jsonb`,
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
		const res = await createProject({
			name: 'Default Image Project',
			description: VALID_DESCRIPTION,
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.docker_base_image).toBe('hezo/agent-base:latest');
	});

	it('honors an explicit docker_base_image from the request body', async () => {
		const res = await createProject({
			name: 'Custom Image Project',
			description: VALID_DESCRIPTION,
			docker_base_image: 'python:3.12-slim',
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.docker_base_image).toBe('python:3.12-slim');
	});

	it('rejects a missing description at the POST /projects route', async () => {
		const res = await app.request(`/api/projects`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Missing description' }),
		});
		expect(res.status).toBe(400);
	});

	it('rejects a blank description at the POST /projects route', async () => {
		const res = await app.request(`/api/projects`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Blank description', description: '   ' }),
		});
		expect(res.status).toBe(400);
	});

	it('lists projects with counts', async () => {
		const projects = await listTeamProjects();
		expect(projects.length).toBeGreaterThanOrEqual(1);
		expect(projects[0]).toHaveProperty('repo_count');
		expect(projects[0]).toHaveProperty('open_task_count');
	});

	it('gets a project by id with repos', async () => {
		const project = (await listTeamProjects())[0];

		const res = await app.request(`/api/projects/${project.id}`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data).toHaveProperty('repos');
	});

	it('updates a project', async () => {
		const project = (await listTeamProjects()).find((p) => p.slug === 'backend-api')!;

		const res = await app.request(`/api/projects/${project.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ description: 'Updated description body.' }),
		});
		expect(res.status).toBe(200);
		const data = (await res.json()).data;
		expect(data.description).toBe('Updated description body.');
	});

	it('generates unique slugs for same-named projects', async () => {
		const res1 = await createProject({
			name: 'Same Name',
			description: VALID_DESCRIPTION,
		});
		const res2 = await createProject({
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
		const createRes = await createProject({
			name: 'Temp Project',
			description: VALID_DESCRIPTION,
		});
		const project = (await createRes.json()).data;

		// The auto-created planning task is open; cancel it so delete can proceed.
		await db.query(`UPDATE tasks SET status = 'cancelled'::task_status WHERE project_id = $1`, [
			project.id,
		]);

		const res = await app.request(`/api/projects/${project.id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
	});
});

describe('initial project plan upload', () => {
	it('saves initial_project_plan as a project doc and references it in the planning task', async () => {
		const planContent = '# My Product\n\n## Overview\nA tool for managing widgets.';
		const res = await createProject({
			name: 'Project Plan Upload Project',
			description: VALID_DESCRIPTION,
			initial_project_plan: planContent,
		});
		expect(res.status).toBe(201);
		const project = (await res.json()).data;

		const docResult = await db.query<{ filename: string; content: string }>(
			"SELECT slug AS filename, content FROM documents WHERE type = 'project_doc' AND project_id = $1 AND slug = $2",
			[project.id, 'project-plan.md'],
		);
		expect(docResult.rows.length).toBe(1);
		expect(docResult.rows[0].content).toBe(planContent);

		const taskResult = await db.query<{ description: string }>(
			`SELECT description FROM tasks WHERE project_id = $1 AND labels @> '["planning"]'::jsonb`,
			[project.id],
		);
		expect(taskResult.rows[0].description).toContain('project-plan.md');
		expect(taskResult.rows[0].description).toContain('starting point for planning');
	});

	it('creates the coherence review as the first ticket, blocking the planning task', async () => {
		const res = await createProject({ name: 'Coherence Order Project' });
		expect(res.status).toBe(201);
		const project = (await res.json()).data;

		const tasks = await db.query<{
			id: string;
			number: number;
			identifier: string;
			labels: string[];
		}>('SELECT id, number, identifier, labels FROM tasks WHERE project_id = $1 ORDER BY number', [
			project.id,
		]);

		const coherence = tasks.rows.find((t) => t.labels.includes('team-coherence-review'));
		const planning = tasks.rows.find((t) => t.labels.includes('planning'));
		expect(coherence?.number).toBe(1);
		expect(planning?.number).toBe(2);

		const dep = await db.query(
			'SELECT 1 FROM task_dependencies WHERE task_id = $1 AND blocked_by_task_id = $2',
			[planning?.id, coherence?.id],
		);
		expect(dep.rows.length).toBe(1);
	});

	it('does not create project-plan.md when initial_project_plan is not provided', async () => {
		const res = await createProject({
			name: 'No Plan Project',
			description: VALID_DESCRIPTION,
		});
		expect(res.status).toBe(201);
		const project = (await res.json()).data;

		const docResult = await db.query(
			"SELECT 1 FROM documents WHERE type = 'project_doc' AND project_id = $1 AND slug = $2",
			[project.id, 'project-plan.md'],
		);
		expect(docResult.rows.length).toBe(0);

		const taskResult = await db.query<{ description: string }>(
			'SELECT description FROM tasks WHERE project_id = $1',
			[project.id],
		);
		expect(taskResult.rows[0].description).not.toContain('project-plan.md');
	});

	it('ignores empty/whitespace-only initial_project_plan', async () => {
		const res = await createProject({
			name: 'Empty Plan Project',
			description: VALID_DESCRIPTION,
			initial_project_plan: '   ',
		});
		expect(res.status).toBe(201);
		const project = (await res.json()).data;

		const docResult = await db.query(
			"SELECT 1 FROM documents WHERE type = 'project_doc' AND project_id = $1 AND slug = $2",
			[project.id, 'project-plan.md'],
		);
		expect(docResult.rows.length).toBe(0);
	});
});

describe('default project docs', () => {
	it('seeds architecture-guidelines.md for every new project', async () => {
		const res = await createProject({
			name: 'Defaults Project',
			description: VALID_DESCRIPTION,
		});
		expect(res.status).toBe(201);
		const project = (await res.json()).data;

		const docResult = await db.query<{ title: string; content: string }>(
			"SELECT title, content FROM documents WHERE type = 'project_doc' AND project_id = $1 AND slug = $2",
			[project.id, 'architecture-guidelines.md'],
		);
		expect(docResult.rows.length).toBe(1);
		expect(docResult.rows[0].title).toBe('Architecture Guidelines');
		expect(docResult.rows[0].content.length).toBeGreaterThan(0);
	});

	it('seeds the architecture-guidelines.md default alongside an initial project plan', async () => {
		const res = await createProject({
			name: 'Defaults With Plan Project',
			description: VALID_DESCRIPTION,
			initial_project_plan: '# Plan\n\nSome requirements.',
		});
		expect(res.status).toBe(201);
		const project = (await res.json()).data;

		const docResult = await db.query<{ slug: string }>(
			"SELECT slug FROM documents WHERE type = 'project_doc' AND project_id = $1 ORDER BY slug",
			[project.id],
		);
		const slugs = docResult.rows.map((d) => d.slug);
		expect(slugs).toContain('architecture-guidelines.md');
		expect(slugs).toContain('project-plan.md');
	});
});

describe('slug-based project access', () => {
	it('gets a project by slug', async () => {
		const project = (await listTeamProjects()).find((p) => p.slug === 'backend-api')!;

		const res = await app.request(`/api/projects/${project.slug}`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.id).toBe(project.id);
		expect(body.data.slug).toBe('backend-api');
	});

	it('returns 404 for non-existent project slug', async () => {
		const res = await app.request(`/api/projects/nonexistent-slug`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(404);
	});

	it('accesses a project by slug', async () => {
		const res = await app.request(`/api/projects/backend-api`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.name).toBe('Backend API');
	});

	it('updates a project by slug', async () => {
		const res = await app.request(`/api/projects/backend-api`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ description: 'Slug-based update' }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.description).toBe('Slug-based update');
	});
});

describe('project archive / unarchive', () => {
	// A fresh project per assertion keeps this suite independent of the CRUD
	// block's shared `backend-api` project.
	async function newProjectSlug(name: string): Promise<string> {
		const res = await createProject({ name, description: VALID_DESCRIPTION });
		expect(res.status).toBe(201);
		return (await res.json()).data.slug as string;
	}

	async function archive(slug: string, headers = authHeader(token)) {
		return app.request(`/api/projects/${slug}/archive`, { method: 'POST', headers });
	}
	async function unarchive(slug: string, headers = authHeader(token)) {
		return app.request(`/api/projects/${slug}/unarchive`, { method: 'POST', headers });
	}
	async function listSlugs(filter?: string): Promise<string[]> {
		const url = filter ? `/api/projects?filter=${filter}` : '/api/projects';
		const res = await app.request(url, { headers: authHeader(token) });
		return ((await res.json()).data as Array<{ slug: string }>).map((p) => p.slug);
	}

	it('archives a project: stamps archived_at and hides it from the default index', async () => {
		const slug = await newProjectSlug('Archive Me');

		expect(await listSlugs()).toContain(slug);

		const res = await archive(slug);
		expect(res.status).toBe(200);
		expect((await res.json()).data.archived_at).not.toBeNull();

		// Default index (the rail) excludes it; ?filter=archived includes it.
		expect(await listSlugs()).not.toContain(slug);
		expect(await listSlugs('archived')).toContain(slug);
		expect(await listSlugs('all')).toContain(slug);
	});

	it('unarchives a project: clears archived_at and restores it to the index', async () => {
		const slug = await newProjectSlug('Restore Me');
		await archive(slug);
		expect(await listSlugs()).not.toContain(slug);

		const res = await unarchive(slug);
		expect(res.status).toBe(200);
		expect((await res.json()).data.archived_at).toBeNull();
		expect(await listSlugs()).toContain(slug);
		expect(await listSlugs('archived')).not.toContain(slug);
	});

	it('refuses to archive an internal project (403)', async () => {
		const internal = await db.query<{ slug: string }>(
			'SELECT slug FROM projects WHERE is_internal = true LIMIT 1',
		);
		const res = await archive(internal.rows[0].slug);
		expect(res.status).toBe(403);
	});

	it('rejects archive/unarchive from a non-superuser team member (403)', async () => {
		const slug = await newProjectSlug('Guard Me');
		const projectRow = await db.query<{ id: string; team_id: string }>(
			'SELECT id, team_id FROM projects WHERE slug = $1',
			[slug],
		);
		const projectTeamId = projectRow.rows[0].team_id;

		// A non-superuser who IS a member of the project's team — so the request
		// clears the team-access middleware and 403s specifically on requireSuperuser.
		const userRes = await db.query<{ id: string }>(
			"INSERT INTO users (display_name, is_superuser) VALUES ('Board User', false) RETURNING id",
		);
		const memberRes = await db.query<{ id: string }>(
			`INSERT INTO members (team_id, display_name, member_type)
			 VALUES ($1, 'Board User', 'user') RETURNING id`,
			[projectTeamId],
		);
		await db.query('INSERT INTO member_users (id, user_id) VALUES ($1, $2)', [
			memberRes.rows[0].id,
			userRes.rows[0].id,
		]);
		const nonSuperToken = await signAdminJwt(masterKeyManager, userRes.rows[0].id);

		expect((await archive(slug, authHeader(nonSuperToken))).status).toBe(403);
		expect((await unarchive(slug, authHeader(nonSuperToken))).status).toBe(403);
		// Still active — the rejected archive was a no-op.
		expect(await listSlugs()).toContain(slug);
	});
});
