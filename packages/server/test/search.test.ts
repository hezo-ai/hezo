import type { PGlite } from '@electric-sql/pglite';
import { AuthType } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/lib/types';
import { getAccessibleTeamIds } from '../src/middleware/auth';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestTeam, projectSlugForTeamSlug } from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let projectSlug: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const typesRes = await app.request('/api/team-templates', {
		headers: authHeader(token),
	});
	const typeId = (await typesRes.json()).data.find(
		(t: Record<string, unknown>) => t.name === 'Startup',
	).id;

	const teamRes = await createTestTeam(db, { name: 'Search Test Co', template_id: typeId });
	const teamSlug = (await teamRes.json()).data.slug;
	projectSlug = `${await projectSlugForTeamSlug(db, teamSlug)}`;

	// Seed a task with a distinctive term so the routes have something to find.
	const proj = await db.query<{ id: string; team_id: string }>(
		'SELECT id, team_id FROM projects WHERE slug = $1',
		[projectSlug],
	);
	const { id: projectId, team_id: teamId } = proj.rows[0];
	const num = (
		await db.query<{ n: number }>(
			'SELECT COALESCE(MAX(number), 0) + 1 AS n FROM tasks WHERE project_id = $1',
			[projectId],
		)
	).rows[0].n;
	await db.query(
		`INSERT INTO tasks (team_id, project_id, number, identifier, title, description)
		 VALUES ($1, $2, $3, $4, 'Zebra onboarding flow', 'Track the zebra rollout')`,
		[teamId, projectId, num, `ZEB-${num}`],
	);
});

afterAll(async () => {
	await safeClose(db);
});

describe('GET /projects/:projectId/search', () => {
	it('returns 400 when q parameter is missing', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/search`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBeDefined();
	});

	it('returns 400 when q parameter is empty', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/search?q=`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(400);
	});

	it('returns 400 when q parameter is whitespace', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/search?q=%20%20`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(400);
	});

	it('returns matching results immediately, with no loading message', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/search?q=zebra`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.message).toBeUndefined();
		expect(body.data.results.some((r: { title: string }) => r.title.includes('Zebra'))).toBe(true);
	});

	it('passes scope parameter through (skills scope excludes the task)', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/search?q=zebra&scope=skills`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.results).toEqual([]);
	});

	it('passes limit parameter through', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/search?q=zebra&limit=5`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
	});

	it('returns 404 for a non-existent project', async () => {
		const res = await app.request(
			'/api/projects/00000000-0000-0000-0000-000000000099/search?q=test',
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
	});
});

describe('GET /api/search (global palette)', () => {
	it('returns 400 when q is empty', async () => {
		const res = await app.request('/api/search?q=', { headers: authHeader(token) });
		expect(res.status).toBe(400);
	});

	it('returns matching results immediately, with no loading message', async () => {
		const res = await app.request('/api/search?q=zebra', { headers: authHeader(token) });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.message).toBeUndefined();
		expect(body.data.results.some((r: { title: string }) => r.title.includes('Zebra'))).toBe(true);
	});
});

describe('getAccessibleTeamIds', () => {
	it('gives an approved API key every team (instance-scoped)', async () => {
		const before = await db.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM teams');
		const ids = await getAccessibleTeamIds(db, {
			type: AuthType.ApiKey,
			apiKeyId: 'ak-1',
			isSuperuser: true,
			crossTeam: true,
		});
		expect(ids).toHaveLength(Number(before.rows[0].count));
	});

	it('gives a superuser every team (HQ included)', async () => {
		const ids = await getAccessibleTeamIds(db, {
			type: AuthType.Admin,
			userId: '00000000-0000-0000-0000-000000000000',
			isSuperuser: true,
		});
		const all = await db.query<{ id: string }>('SELECT id FROM teams');
		expect(ids.length).toBe(all.rows.length);
		expect(ids.length).toBeGreaterThanOrEqual(1);
		expect([...ids].sort()).toEqual(all.rows.map((r) => r.id).sort());
	});

	it('limits a non-superuser board user to the teams they belong to', async () => {
		const memberTeam = await db.query<{ id: string }>(
			"INSERT INTO teams (name, slug) VALUES ('Member Team', 'member-team') RETURNING id",
		);
		const teamId = memberTeam.rows[0].id;
		await db.query("INSERT INTO teams (name, slug) VALUES ('Unrelated Team', 'unrelated-team')");

		const user = await db.query<{ id: string }>(
			"INSERT INTO users (display_name) VALUES ('Board Member') RETURNING id",
		);
		const m = await db.query<{ id: string }>(
			"INSERT INTO members (team_id, member_type, display_name) VALUES ($1, 'user', 'Board Member') RETURNING id",
			[teamId],
		);
		await db.query('INSERT INTO member_users (id, user_id) VALUES ($1, $2)', [
			m.rows[0].id,
			user.rows[0].id,
		]);

		const ids = await getAccessibleTeamIds(db, {
			type: AuthType.Admin,
			userId: user.rows[0].id,
			isSuperuser: false,
		});
		expect(ids).toEqual([teamId]);
	});
});
