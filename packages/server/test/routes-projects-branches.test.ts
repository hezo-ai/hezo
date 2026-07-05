import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

/**
 * Remaining branch coverage for packages/server/src/routes/projects.ts that
 * projects-coverage.test.ts / projects-routes-extended.test.ts / projects.test.ts
 * don't reach: the requireAdminEquivalent denial arms on the create/intake
 * routes, the missing-name validation, the Blank/template/source baseline arms
 * of POST /project-intakes, the description-only PATCH set, the icon-bearing
 * row in the GET /projects index, and the container/stop "no container id" arm.
 */

let app: Hono<Env>;
let db: Db;
let token: string;
let nonAdminToken: string;
let teamId: string;
let projectSlug: string;
let projectId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	// A non-superuser admin (board user, no team membership) — drives the
	// requireAdminEquivalent FORBIDDEN arm on the instance-management routes.
	const plain = await db.query<{ id: string }>(
		"INSERT INTO users (display_name, is_superuser) VALUES ('Plain User', false) RETURNING id",
	);
	nonAdminToken = await signAdminJwt(ctx.masterKeyManager, plain.rows[0].id);

	const teamRes = await createTestTeam(db, { name: 'Projects Branch Co' });
	teamId = (await teamRes.json()).data.id;
	const projRes = await createTestProject(db, teamId, {
		name: 'Branch Project',
		description: 'For exercising the remaining route branches.',
	});
	const proj = (await projRes.json()).data;
	projectSlug = proj.slug;
	projectId = proj.id;
});

afterAll(async () => {
	await safeClose(db);
});

function jsonHeaders(t: string) {
	return { ...authHeader(t), 'Content-Type': 'application/json' };
}

describe('POST /projects — authorization + validation arms', () => {
	it('403s for a non-superuser admin (requireAdminEquivalent denial)', async () => {
		const res = await app.request('/api/projects', {
			method: 'POST',
			headers: jsonHeaders(nonAdminToken),
			body: JSON.stringify({ name: 'X', description: 'Y' }),
		});
		expect(res.status).toBe(403);
		expect((await res.json()).error.code).toBe('FORBIDDEN');
	});

	it('400s when name is missing', async () => {
		const res = await app.request('/api/projects', {
			method: 'POST',
			headers: jsonHeaders(token),
			body: JSON.stringify({ description: 'has description but no name' }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/name is required/);
	});
});

describe('POST /project-intakes — baseline arms', () => {
	it('403s for a non-superuser admin', async () => {
		const res = await app.request('/api/project-intakes', {
			method: 'POST',
			headers: jsonHeaders(nonAdminToken),
			body: JSON.stringify({ name: 'X', description: 'Y' }),
		});
		expect(res.status).toBe(403);
	});

	it('400s when name is missing', async () => {
		const res = await app.request('/api/project-intakes', {
			method: 'POST',
			headers: jsonHeaders(token),
			body: JSON.stringify({ description: 'no name' }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/name is required/);
	});

	it('400s when description is missing', async () => {
		const res = await app.request('/api/project-intakes', {
			method: 'POST',
			headers: jsonHeaders(token),
			body: JSON.stringify({ name: 'Has name' }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/description is required/);
	});

	it('404s for an unknown template_id', async () => {
		const res = await app.request('/api/project-intakes', {
			method: 'POST',
			headers: jsonHeaders(token),
			body: JSON.stringify({
				name: 'Bad Template Intake',
				description: 'A description.',
				template_id: '00000000-0000-0000-0000-000000000000',
			}),
		});
		expect(res.status).toBe(404);
		expect((await res.json()).error.message).toMatch(/Team template not found/);
	});

	it('opens an intake with the Blank baseline when neither template nor source is given', async () => {
		const res = await app.request('/api/project-intakes', {
			method: 'POST',
			headers: jsonHeaders(token),
			body: JSON.stringify({
				name: 'Blank Baseline Intake',
				description: 'CEO will scope this with the admin.',
			}),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()).data;
		expect(body.intake_task_id).toBeTruthy();
		expect(body.intake_task_identifier).toBeTruthy();
	});

	it('opens an intake with a real source team as the baseline', async () => {
		const srcRes = await createTestTeam(db, { name: 'Intake Source Co' });
		const srcId = (await srcRes.json()).data.id;
		const res = await app.request('/api/project-intakes', {
			method: 'POST',
			headers: jsonHeaders(token),
			body: JSON.stringify({
				name: 'Source Baseline Intake',
				description: 'Clone the source roster as the baseline.',
				source_team_id: srcId,
			}),
		});
		expect(res.status).toBe(201);
		expect((await res.json()).data.intake_task_id).toBeTruthy();
	});
});

describe('GET /project-intakes — authorization arm', () => {
	it('403s for a non-superuser admin', async () => {
		const res = await app.request('/api/project-intakes', { headers: authHeader(nonAdminToken) });
		expect(res.status).toBe(403);
	});
});

describe('PATCH /projects/:projectId — description-only set', () => {
	it('updates only the description (description !== undefined arm)', async () => {
		const res = await app.request(`/api/projects/${projectSlug}`, {
			method: 'PATCH',
			headers: jsonHeaders(token),
			body: JSON.stringify({ description: 'Updated description only.' }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.description).toBe('Updated description only.');
	});
});

describe('GET /projects — icon_url present on a project with an icon', () => {
	it('signs an icon_url for the icon-bearing row (withIconUrl truthy arm)', async () => {
		await db.query(
			`INSERT INTO project_icons (project_id, content_type, data, byte_size, width, height, updated_at)
			 VALUES ($1, 'image/png', $2, 3, 1, 1, now())
			 ON CONFLICT (project_id) DO UPDATE SET updated_at = now()`,
			[projectId, Buffer.from([1, 2, 3])],
		);
		const res = await app.request('/api/projects', { headers: authHeader(token) });
		expect(res.status).toBe(200);
		const list = (await res.json()).data as Array<{ id: string; icon_url: string | null }>;
		const row = list.find((p) => p.id === projectId);
		expect(row?.icon_url).toBeTruthy();
		// And a project with no icon stays null.
		const noIcon = list.find((p) => p.id !== projectId && p.icon_url === null);
		expect(noIcon).toBeTruthy();
	});
});

describe('container/stop — no container id arm', () => {
	it('sets status to stopped immediately when the project has no container', async () => {
		// projectId has container_id NULL by default (createTestProject provisions none).
		const res = await app.request(`/api/projects/${projectSlug}/container/stop`, {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.container_status).toBe('stopped');
	});
});
