import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let teamId: string;
let projectId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	// Create team
	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const types = (await typesRes.json()).data;
	const builtinTypeId = types.find((t: any) => t.name === 'Startup').id;

	const teamRes = await createTestTeam(db, { name: 'Repo Test Co', template_id: builtinTypeId });
	teamId = (await teamRes.json()).data.id;

	// Create project
	const projectRes = await createTestProject(db, teamId, {
		name: 'Test Project',
		description: 'Testing repos.',
	});
	projectId = (await projectRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('repos CRUD', () => {
	it('lists repos (empty initially)', async () => {
		const res = await app.request(`/api/projects/${projectId}/repos`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data).toEqual([]);
	});

	it('returns INVALID_URL for bad URLs', async () => {
		const res = await app.request(`/api/projects/${projectId}/repos`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ url: 'not-a-url' }),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.code).toBe('INVALID_URL');
	});

	it('returns INVALID_REQUEST for missing fields', async () => {
		const res = await app.request(`/api/projects/${projectId}/repos`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	it('deletes a repo', async () => {
		// Insert a repo directly for deletion test
		const insertResult = await db.query<{ id: string }>(
			`INSERT INTO repos (project_id, repo_identifier, host_type)
			 VALUES ($1, 'acme/to-delete', 'github') RETURNING id`,
			[projectId],
		);
		const repoId = insertResult.rows[0].id;

		const res = await app.request(`/api/projects/${projectId}/repos/${repoId}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.deleted).toBe(true);
	});

	it('returns 404 when deleting non-existent repo', async () => {
		const res = await app.request(
			`/api/projects/${projectId}/repos/00000000-0000-0000-0000-000000000000`,
			{ method: 'DELETE', headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
	});

	it('enforces unique repo name within project, even across owners', async () => {
		await db.query(
			`INSERT INTO repos (project_id, repo_identifier, host_type)
			 VALUES ($1, 'acme/unique-test', 'github')`,
			[projectId],
		);

		// A repo with the same name under a different owner would clash on the
		// workspace directory, so the DB must reject it.
		try {
			await db.query(
				`INSERT INTO repos (project_id, repo_identifier, host_type)
				 VALUES ($1, 'other-org/unique-test', 'github')`,
				[projectId],
			);
			expect.fail('Should have thrown on duplicate repo name');
		} catch (e: any) {
			expect(e.message).toContain('unique');
		}
	});
});
