import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../lib/types';
import { safeClose } from '../helpers';
import { authHeader, createTestApp } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let companyId: string;

const VALID_DESCRIPTION = 'A backend API that serves authenticated requests for the main app.';

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Project Test Co', issue_prefix: 'PTC' }),
	});
	companyId = (await companyRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('projects CRUD', () => {
	it('creates a project with description and auto-opens a planning issue for the CEO', async () => {
		const res = await app.request(`/api/companies/${companyId}/projects`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Backend API',
				description: VALID_DESCRIPTION,
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.name).toBe('Backend API');
		expect(body.data.slug).toBe('backend-api');
		expect(body.data.company_id).toBe(companyId);
		expect(body.data.description).toBe(VALID_DESCRIPTION);

		const ceoResult = await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE m.company_id = $1 AND ma.slug = 'ceo' LIMIT 1`,
			[companyId],
		);
		const ceoId = ceoResult.rows[0]?.id;
		expect(ceoId).toBeDefined();

		const issueResult = await db.query<{
			id: string;
			title: string;
			description: string;
			assignee_id: string;
			status: string;
			priority: string;
			labels: string[] | string;
		}>(
			'SELECT id, title, description, assignee_id, status, priority, labels FROM issues WHERE project_id = $1',
			[body.data.id],
		);
		expect(issueResult.rows.length).toBe(1);
		const issue = issueResult.rows[0];
		expect(issue.assignee_id).toBe(ceoId);
		expect(issue.status).toBe('open');
		expect(issue.priority).toBe('high');
		expect(issue.title).toContain('Draft execution plan');
		expect(issue.description).toContain(VALID_DESCRIPTION);
		const labels = typeof issue.labels === 'string' ? JSON.parse(issue.labels) : issue.labels;
		expect(labels).toContain('planning');

		expect(body.data.planning_issue_id).toBe(issue.id);

		const wakeupResult = await db.query<{
			source: string;
			payload: Record<string, unknown> | string;
		}>(
			`SELECT source, payload FROM agent_wakeup_requests
			 WHERE member_id = $1 AND company_id = $2 AND source = 'assignment'`,
			[ceoId, companyId],
		);
		expect(wakeupResult.rows.length).toBeGreaterThanOrEqual(1);
		const payload =
			typeof wakeupResult.rows[0].payload === 'string'
				? JSON.parse(wakeupResult.rows[0].payload)
				: wakeupResult.rows[0].payload;
		expect(payload.issue_id).toBe(issue.id);
	});

	it('defaults docker_base_image to the bundled agent-base image when not supplied', async () => {
		const res = await app.request(`/api/companies/${companyId}/projects`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Default Image Project',
				description: VALID_DESCRIPTION,
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.docker_base_image).toBe('hezo/agent-base:latest');
	});

	it('honors an explicit docker_base_image from the request body', async () => {
		const res = await app.request(`/api/companies/${companyId}/projects`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Custom Image Project',
				description: VALID_DESCRIPTION,
				docker_base_image: 'python:3.12-slim',
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.docker_base_image).toBe('python:3.12-slim');
	});

	it('rejects a missing description', async () => {
		const res = await app.request(`/api/companies/${companyId}/projects`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Missing description' }),
		});
		expect(res.status).toBe(400);
	});

	it('rejects a blank description', async () => {
		const res = await app.request(`/api/companies/${companyId}/projects`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Blank description', description: '   ' }),
		});
		expect(res.status).toBe(400);
	});

	it('lists projects with counts', async () => {
		const res = await app.request(`/api/companies/${companyId}/projects`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBeGreaterThanOrEqual(1);
		expect(body.data[0]).toHaveProperty('repo_count');
		expect(body.data[0]).toHaveProperty('open_issue_count');
	});

	it('gets a project by id with repos', async () => {
		const listRes = await app.request(`/api/companies/${companyId}/projects`, {
			headers: authHeader(token),
		});
		const project = (await listRes.json()).data[0];

		const res = await app.request(`/api/companies/${companyId}/projects/${project.id}`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data).toHaveProperty('repos');
	});

	it('updates a project', async () => {
		const listRes = await app.request(`/api/companies/${companyId}/projects`, {
			headers: authHeader(token),
		});
		const project = (await listRes.json()).data.find(
			(p: { slug: string }) => p.slug === 'backend-api',
		);

		const res = await app.request(`/api/companies/${companyId}/projects/${project.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ description: 'Updated description body.' }),
		});
		expect(res.status).toBe(200);
		const data = (await res.json()).data;
		expect(data.description).toBe('Updated description body.');
	});

	it('generates unique slugs for same-named projects', async () => {
		const res1 = await app.request(`/api/companies/${companyId}/projects`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Same Name', description: VALID_DESCRIPTION }),
		});
		const res2 = await app.request(`/api/companies/${companyId}/projects`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Same Name', description: VALID_DESCRIPTION }),
		});
		expect(res1.status).toBe(201);
		expect(res2.status).toBe(201);
		const slug1 = (await res1.json()).data.slug;
		const slug2 = (await res2.json()).data.slug;
		expect(slug1).toBe('same-name');
		expect(slug2).toBe('same-name-2');
	});

	it('deletes a project with no open issues', async () => {
		const createRes = await app.request(`/api/companies/${companyId}/projects`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Temp Project', description: VALID_DESCRIPTION }),
		});
		const project = (await createRes.json()).data;

		// The auto-created planning issue is open; cancel it so delete can proceed.
		await db.query(`UPDATE issues SET status = 'cancelled'::issue_status WHERE project_id = $1`, [
			project.id,
		]);

		const res = await app.request(`/api/companies/${companyId}/projects/${project.id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
	});
});

describe('slug-based project access', () => {
	it('gets a project by slug', async () => {
		const listRes = await app.request(`/api/companies/${companyId}/projects`, {
			headers: authHeader(token),
		});
		const project = (await listRes.json()).data.find(
			(p: { slug: string }) => p.slug === 'backend-api',
		);

		const res = await app.request(`/api/companies/${companyId}/projects/${project.slug}`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.id).toBe(project.id);
		expect(body.data.slug).toBe('backend-api');
	});

	it('returns 404 for non-existent project slug', async () => {
		const res = await app.request(`/api/companies/${companyId}/projects/nonexistent-slug`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(404);
	});

	it('accesses company by slug and project by slug together', async () => {
		const companiesRes = await app.request('/api/companies', {
			headers: authHeader(token),
		});
		const company = (await companiesRes.json()).data.find(
			(c: { slug: string }) => c.slug === 'project-test-co',
		);

		const res = await app.request(`/api/companies/${company.slug}/projects/backend-api`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.name).toBe('Backend API');
	});

	it('updates a project by slug', async () => {
		const res = await app.request(`/api/companies/${companyId}/projects/backend-api`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ description: 'Slug-based update' }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.description).toBe('Slug-based update');
	});
});
