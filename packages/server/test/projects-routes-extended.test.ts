import { ContainerStatus } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let teamId: string;
let projectId: string;
let projectSlug: string;
let memberUserToken: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const teamRes = await createTestTeam(db, { name: 'Projects Ext Co' });
	teamId = (await teamRes.json()).data.id;

	// A non-superuser admin who is a member of this team — exercises the
	// board-user-filtered branch of GET /projects.
	const memberUser = await db.query<{ id: string }>(
		"INSERT INTO users (display_name, is_superuser) VALUES ('Board User', false) RETURNING id",
	);
	const memberUserId = memberUser.rows[0].id;
	const member = await db.query<{ id: string }>(
		`INSERT INTO members (team_id, member_type, display_name)
		 VALUES ($1, 'user', 'Board User') RETURNING id`,
		[teamId],
	);
	await db.query(`INSERT INTO member_users (id, user_id) VALUES ($1, $2)`, [
		member.rows[0].id,
		memberUserId,
	]);
	memberUserToken = await signAdminJwt(ctx.masterKeyManager, memberUserId);
	const projRes = await createTestProject(db, teamId, {
		name: 'Ext Project',
		description: 'A project for exercising the route edges.',
	});
	const proj = (await projRes.json()).data;
	projectId = proj.id;
	projectSlug = proj.slug;
});

afterAll(async () => {
	await safeClose(db);
});

async function patch(body: Record<string, unknown>) {
	const res = await app.request(`/api/projects/${projectSlug}`, {
		method: 'PATCH',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('GET /projects — board-user filtered list', () => {
	it('returns only the projects of teams the non-superuser belongs to', async () => {
		const res = await app.request('/api/projects', { headers: authHeader(memberUserToken) });
		expect(res.status).toBe(200);
		const data = (await res.json()).data as Array<{ team_id: string }>;
		expect(data.length).toBeGreaterThan(0);
		// The board user only sees projects in their team, not HQ or other teams.
		expect(data.every((p) => p.team_id === teamId)).toBe(true);
	});
});

describe('PATCH /projects/:projectId — validation + reshaping', () => {
	it('renames the project and regenerates a unique slug', async () => {
		const { status, body } = await patch({ name: 'Renamed Ext Project' });
		expect(status).toBe(200);
		const data = body.data as { name: string; slug: string };
		expect(data.name).toBe('Renamed Ext Project');
		expect(data.slug).toBe('renamed-ext-project');
		projectSlug = data.slug; // keep the handle current for later tests
	});

	it('rejects a non-integer max_concurrent_runs', async () => {
		const { status, body } = await patch({ max_concurrent_runs: 0 });
		expect(status).toBe(400);
		expect((body.error as { message: string }).message).toMatch(/max_concurrent_runs/);
	});

	it('accepts a valid max_concurrent_runs', async () => {
		const { status, body } = await patch({ max_concurrent_runs: 4 });
		expect(status).toBe(200);
		expect((body.data as { max_concurrent_runs: number }).max_concurrent_runs).toBe(4);
	});

	it('rejects a memory_limit_gib below 1', async () => {
		const { status } = await patch({ memory_limit_gib: 0 });
		expect(status).toBe(400);
	});

	it('accepts a valid memory_limit_gib', async () => {
		const { status, body } = await patch({ memory_limit_gib: 8 });
		expect(status).toBe(200);
		expect((body.data as { memory_limit_gib: number }).memory_limit_gib).toBe(8);
	});

	it('updates budget windows when consistent', async () => {
		// weekly ≥ daily×7, monthly ≥ daily×~30.4.
		const { status, body } = await patch({
			daily_budget_cents: 1000,
			weekly_budget_cents: 8000,
			monthly_budget_cents: 40000,
		});
		expect(status).toBe(200);
		expect((body.data as { daily_budget_cents: number }).daily_budget_cents).toBe(1000);
	});

	it('rejects an inconsistent budget trio (daily > weekly)', async () => {
		const { status, body } = await patch({ daily_budget_cents: 9999, weekly_budget_cents: 100 });
		expect(status).toBe(400);
		expect((body.error as { code: string }).code).toBe('INVALID_REQUEST');
	});

	it('treats an empty PATCH body as a no-op and returns the current project', async () => {
		const { status, body } = await patch({});
		expect(status).toBe(200);
		expect((body.data as { id: string }).id).toBe(projectId);
	});

	it('404s for a project the caller cannot resolve', async () => {
		const res = await app.request('/api/projects/does-not-exist-slug', {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ description: 'x' }),
		});
		expect(res.status).toBe(404);
	});
});

describe('DELETE /projects/:projectId — guards', () => {
	it('409s when the project still has open tasks', async () => {
		// The seeded planning task is open.
		const res = await app.request(`/api/projects/${projectSlug}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe('CONFLICT');
	});

	it('403s when deleting the internal HQ project', async () => {
		// HQ is the only is_internal project; resolve it by slug.
		const res = await app.request('/api/projects/hq', {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(403);
	});
});

describe('POST /project-intakes — validation branches', () => {
	async function startIntake(body: Record<string, unknown>) {
		const res = await app.request('/api/project-intakes', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		return { status: res.status, body: (await res.json()) as Record<string, unknown> };
	}

	it('rejects supplying both template_id and source_team_id', async () => {
		const { status, body } = await startIntake({
			name: 'Both',
			description: 'desc',
			template_id: '11111111-1111-1111-1111-111111111111',
			source_team_id: '22222222-2222-2222-2222-222222222222',
		});
		expect(status).toBe(400);
		expect((body.error as { message: string }).message).toMatch(
			/either template_id or source_team_id/,
		);
	});

	it('404s for an unknown source_team_id', async () => {
		const { status } = await startIntake({
			name: 'Ghost Source',
			description: 'desc',
			source_team_id: '33333333-3333-3333-3333-333333333333',
		});
		expect(status).toBe(404);
	});

	it('rejects using the HQ team as a source team', async () => {
		const hq = await db.query<{ id: string }>(
			`SELECT t.id FROM teams t
			 JOIN projects p ON p.team_id = t.id AND p.is_internal = true LIMIT 1`,
		);
		const { status, body } = await startIntake({
			name: 'HQ Clone',
			description: 'desc',
			source_team_id: hq.rows[0].id,
		});
		expect(status).toBe(400);
		expect((body.error as { message: string }).message).toMatch(/HQ team cannot be used/);
	});

	it('records a real source team as the baseline', async () => {
		const { status, body } = await startIntake({
			name: 'Clone Of Ext',
			description: 'desc',
			source_team_id: teamId,
		});
		expect(status).toBe(201);
		const intake = body.data as { intake_task_id: string };
		const task = await db.query<{ description: string }>(
			`SELECT description FROM tasks WHERE id = $1`,
			[intake.intake_task_id],
		);
		// Baseline line names the cloned team.
		expect(task.rows[0].description).toContain('clone of');
		// Clean up so the home-intake list stays predictable for other suites.
		await db.query(`DELETE FROM tasks WHERE id = $1`, [intake.intake_task_id]);
	});
});

describe('container lifecycle routes', () => {
	it('container/start returns NO_CONTAINER when none is provisioned', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/container/start`, {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NO_CONTAINER');
	});

	it('container/start starts the container when one exists (stub docker)', async () => {
		await db.query(
			`UPDATE projects SET container_id = 'stub-container',
			        container_status = 'stopped'::container_status WHERE id = $1`,
			[projectId],
		);
		const res = await app.request(`/api/projects/${projectSlug}/container/start`, {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		expect(
			((await res.json()) as { data: { container_status: string } }).data.container_status,
		).toBe(ContainerStatus.Running);
		const row = await db.query<{ container_status: string }>(
			`SELECT container_status::text AS container_status FROM projects WHERE id = $1`,
			[projectId],
		);
		expect(row.rows[0].container_status).toBe(ContainerStatus.Running);
	});

	it('container/stop sets stopped immediately when no container id is present', async () => {
		await db.query(
			`UPDATE projects SET container_id = NULL,
			        container_status = 'running'::container_status WHERE id = $1`,
			[projectId],
		);
		const res = await app.request(`/api/projects/${projectSlug}/container/stop`, {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		expect(
			((await res.json()) as { data: { container_status: string } }).data.container_status,
		).toBe(ContainerStatus.Stopped);
	});

	it('container/stop transitions to stopping when a container exists', async () => {
		await db.query(
			`UPDATE projects SET container_id = 'stub-container',
			        container_status = 'running'::container_status WHERE id = $1`,
			[projectId],
		);
		const res = await app.request(`/api/projects/${projectSlug}/container/stop`, {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		expect(
			((await res.json()) as { data: { container_status: string } }).data.container_status,
		).toBe(ContainerStatus.Stopping);
	});

	it('container/rebuild kicks off a rebuild and reports creating', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/container/rebuild`, {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		expect(
			((await res.json()) as { data: { container_status: string } }).data.container_status,
		).toBe(ContainerStatus.Creating);
		const row = await db.query<{ container_status: string }>(
			`SELECT container_status::text AS container_status FROM projects WHERE id = $1`,
			[projectId],
		);
		expect(row.rows[0].container_status).toBe(ContainerStatus.Creating);
	});
});
