import { BudgetResource, HQ_PROJECT_SLUG } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRuntimeConfig, setPolicy } from '../src/config/runtime';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import { checkOverBudget, getProjectHoursBudgetStatus } from '../src/services/budget';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestTeam, projectSlugForTeamSlug } from './helpers/app';

/**
 * A project's hours budget: daily, weekly and monthly limits on how long its
 * containers may be up, checked by the same gate as the token budget and set
 * only by a superuser.
 */

let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let projectId: string;
let projectSlug: string;
let agentId: string;

const HOUR = 3600;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const teamRes = await createTestTeam(db, { name: 'Hours Budget Co' });
	const teamSlug = (await teamRes.json()).data.slug;
	projectSlug = await projectSlugForTeamSlug(db, teamSlug);
	const project = await db.query<{ id: string; team_id: string }>(
		'SELECT id, team_id FROM projects WHERE slug = $1',
		[projectSlug],
	);
	projectId = project.rows[0].id;
	teamId = project.rows[0].team_id;
	const agent = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
		  WHERE m.team_id = $1 LIMIT 1`,
		[teamId],
	);
	agentId = agent.rows[0].id;
});

beforeEach(async () => {
	await db.query('DELETE FROM container_uptime_entries');
	await db.query('DELETE FROM usage_entries WHERE project_id = $1', [projectId]);
	await db.query(
		`UPDATE projects
		    SET daily_budget_tokens = 0, weekly_budget_tokens = 0, monthly_budget_tokens = 0,
		        daily_budget_container_seconds = 0, weekly_budget_container_seconds = 0,
		        monthly_budget_container_seconds = 0
		  WHERE id = $1`,
		[projectId],
	);
});

afterEach(() => {
	// A pinned policy lives in process-wide runtime config.
	resetRuntimeConfig();
});

afterAll(async () => {
	await safeClose(db);
});

/**
 * Bank up to `seconds` of container time that falls inside today, this week and
 * this month alike, and return what was actually banked: a stretch reaching back
 * past midnight UTC is cut there, so the figure holds at any hour.
 */
async function bankToday(seconds: number, open = false): Promise<number> {
	const res = await db.query<{ banked: number }>(
		`INSERT INTO container_uptime_entries (project_id, container_id, started_at, ended_at, backend)
		 VALUES ($1, 'ctr-' || gen_random_uuid()::text,
		         GREATEST(date_trunc('second', now()) - ($2::int * interval '1 second'),
		                  date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),
		         CASE WHEN $3::bool THEN NULL ELSE date_trunc('second', now()) END,
		         'docker')
		 RETURNING floor(EXTRACT(EPOCH FROM (COALESCE(ended_at, now()) - started_at)))::int AS banked`,
		[projectId, seconds, open],
	);
	const banked = res.rows[0].banked;
	if (banked <= 0) throw new Error('the UTC day is under a second old - nothing can be banked yet');
	return banked;
}

async function setHoursLimits(daily: number, weekly: number, monthly: number): Promise<void> {
	await db.query(
		`UPDATE projects
		    SET daily_budget_container_seconds = $2, weekly_budget_container_seconds = $3,
		        monthly_budget_container_seconds = $4
		  WHERE id = $1`,
		[projectId, daily, weekly, monthly],
	);
}

/** A non-superuser admin of the project's team, signed in. */
async function boardAdminToken(): Promise<string> {
	const user = await db.query<{ id: string }>(
		"INSERT INTO users (display_name, is_superuser) VALUES ('Board Admin', false) RETURNING id",
	);
	const member = await db.query<{ id: string }>(
		`INSERT INTO members (team_id, member_type, display_name)
		 VALUES ($1, 'user', 'Board Admin') RETURNING id`,
		[teamId],
	);
	await db.query(`INSERT INTO member_users (id, user_id, role) VALUES ($1, $2, 'admin')`, [
		member.rows[0].id,
		user.rows[0].id,
	]);
	return signAdminJwt(masterKeyManager, user.rows[0].id);
}

function patchHours(body: Record<string, unknown>, as = token, slug = projectSlug) {
	return app.request(`/api/projects/${slug}/container-hours`, {
		method: 'PATCH',
		headers: { ...authHeader(as), 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
}

describe('the gate', () => {
	it('never reads the ledger for a project with no hours limit', async () => {
		await bankToday(600);
		expect(await checkOverBudget(db, agentId, projectId)).toBeNull();
	});

	it('blocks on the daily window once the project has used its daily hours', async () => {
		const banked = await bankToday(600);
		await setHoursLimits(60, 0, 0);
		const block = await checkOverBudget(db, agentId, projectId);
		expect(block).toMatchObject({
			scope: 'project',
			period: 'daily',
			resource: BudgetResource.ContainerHours,
			limit: 60,
		});
		expect(block?.used).toBeGreaterThanOrEqual(banked);
	});

	it('counts a container still up to this instant', async () => {
		await bankToday(120, true);
		await setHoursLimits(0, 60, 0);
		expect(await checkOverBudget(db, agentId, projectId)).toMatchObject({
			period: 'weekly',
			resource: BudgetResource.ContainerHours,
		});
	});

	it('lets a project under every limit through', async () => {
		await bankToday(60);
		await setHoursLimits(HOUR, 7 * HOUR, 31 * HOUR);
		expect(await checkOverBudget(db, agentId, projectId)).toBeNull();
	});

	it('does not count another project’s hours', async () => {
		await db.query(
			`INSERT INTO container_uptime_entries (project_id, container_id, started_at, ended_at, backend)
			 VALUES (NULL, 'ctr-elsewhere', now() - interval '1 minute', now(), 'docker')`,
		);
		await setHoursLimits(1, 0, 0);
		expect(await checkOverBudget(db, agentId, projectId)).toBeNull();
	});

	it('names the token budget first when both are spent', async () => {
		await bankToday(600);
		await setHoursLimits(60, 0, 0);
		await db.query('UPDATE projects SET daily_budget_tokens = 10 WHERE id = $1', [projectId]);
		await db.query(
			`INSERT INTO usage_entries (member_id, project_id, input_tokens) VALUES ($1, $2, 50)`,
			[agentId, projectId],
		);
		expect(await checkOverBudget(db, agentId, projectId)).toMatchObject({
			scope: 'project',
			resource: BudgetResource.Tokens,
		});
	});

	it('counts the monthly window from where the container-hours window starts', async () => {
		const banked = await bankToday(600);
		await setHoursLimits(0, 0, 60);
		expect(await checkOverBudget(db, agentId, projectId)).toMatchObject({ period: 'monthly' });

		// A deployer that counts from an instant moves where the month starts, and
		// the project's month moves with it: none of the banked stretch is in it.
		setPolicy({
			managedBy: 'Acme Cloud',
			pinned: { containerHoursSince: new Date().toISOString() },
		});
		const status = await getProjectHoursBudgetStatus(db, projectId);
		expect(status.monthly.used_seconds).toBeLessThan(60);
		expect(status.daily.used_seconds).toBeGreaterThanOrEqual(banked);
		expect(await checkOverBudget(db, agentId, projectId)).toBeNull();
	});
});

describe('GET /api/projects/:projectId/container-hours', () => {
	it('carries the budget, window by window', async () => {
		const banked = await bankToday(600);
		await setHoursLimits(60, 0, 0);
		const res = await app.request(`/api/projects/${projectSlug}/container-hours`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const { data } = await res.json();
		expect(data.budget.daily.limit_seconds).toBe(60);
		expect(data.budget.daily.used_seconds).toBeGreaterThanOrEqual(banked);
		expect(data.budget.daily.over_budget).toBe(true);
		expect(data.budget.weekly).toMatchObject({ limit_seconds: 0, over_budget: false });
		expect(data.budget.over_budget).toBe(true);
		expect(data.metered).toBe(false);
	});
});

describe('PATCH /api/projects/:projectId/container-hours', () => {
	it('sets the limits and answers with the budget', async () => {
		const res = await patchHours({
			daily_budget_container_seconds: HOUR,
			weekly_budget_container_seconds: 7 * HOUR,
		});
		expect(res.status).toBe(200);
		const { data } = await res.json();
		expect(data.budget.daily.limit_seconds).toBe(HOUR);
		expect(data.budget.weekly.limit_seconds).toBe(7 * HOUR);
		expect(data.budget.monthly.limit_seconds).toBe(0);
	});

	it('checks a partial write against what it leaves', async () => {
		await setHoursLimits(HOUR, 7 * HOUR, 0);
		// A five-hour week under a one-hour day breaks the floor the stored day sets.
		const res = await patchHours({ weekly_budget_container_seconds: 5 * HOUR });
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('at least 7 hours');

		const ok = await patchHours({ monthly_budget_container_seconds: 31 * HOUR });
		expect(ok.status).toBe(200);
		const { data } = await ok.json();
		expect(data.budget.daily.limit_seconds).toBe(HOUR);
		expect(data.budget.monthly.limit_seconds).toBe(31 * HOUR);
	});

	it('keeps both of two saves that overlap, each merged over the other', async () => {
		// One sets only the day, the other only the period. Each reads the stored
		// trio and writes all three. The first save is held after its read until
		// the second has read too - or, when the second cannot read until the first
		// has written, for a short wait - so the overlap that loses an update is
		// forced rather than left to timing.
		const query = db.query.bind(db);
		let reads = 0;
		let secondRead: () => void = () => {};
		const secondHasRead = new Promise<void>((resolve) => {
			secondRead = resolve;
		});
		const spy = vi.spyOn(db, 'query').mockImplementation((async (
			sql: string,
			params?: unknown[],
		) => {
			const isBudgetRead = sql.includes('is_internal') && sql.includes('budget_container_seconds');
			const result = await query(sql, params);
			if (isBudgetRead) {
				reads += 1;
				if (reads === 1) {
					await Promise.race([secondHasRead, new Promise((resolve) => setTimeout(resolve, 300))]);
				} else {
					secondRead();
				}
			}
			return result;
		}) as any);
		try {
			const [daily, monthly] = await Promise.all([
				patchHours({ daily_budget_container_seconds: HOUR }),
				patchHours({ monthly_budget_container_seconds: 40 * HOUR }),
			]);
			expect(daily.status).toBe(200);
			expect(monthly.status).toBe(200);
		} finally {
			spy.mockRestore();
		}
		const stored = await db.query<{ daily: string; monthly: string }>(
			`SELECT daily_budget_container_seconds AS daily, monthly_budget_container_seconds AS monthly
			   FROM projects WHERE id = $1`,
			[projectId],
		);
		expect(Number(stored.rows[0].daily)).toBe(HOUR);
		expect(Number(stored.rows[0].monthly)).toBe(40 * HOUR);
	});

	it('refuses a negative, fractional or missing value', async () => {
		expect((await patchHours({ daily_budget_container_seconds: -1 })).status).toBe(400);
		expect((await patchHours({ daily_budget_container_seconds: 1.5 })).status).toBe(400);
		expect((await patchHours({ daily_budget_container_seconds: '60' })).status).toBe(400);
		expect((await patchHours({})).status).toBe(400);
	});

	it('is the superuser’s alone', async () => {
		const res = await patchHours({ daily_budget_container_seconds: HOUR }, await boardAdminToken());
		expect(res.status).toBe(403);
		const stored = await db.query<{ daily: string }>(
			'SELECT daily_budget_container_seconds AS daily FROM projects WHERE id = $1',
			[projectId],
		);
		expect(Number(stored.rows[0].daily)).toBe(0);
	});

	it('refuses HQ, which draws on the instance allowance', async () => {
		const res = await patchHours({ daily_budget_container_seconds: HOUR }, token, HQ_PROJECT_SLUG);
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('instance');
	});
});

describe('the project edit', () => {
	it('refuses an hours field by name rather than dropping it', async () => {
		const res = await app.request(`/api/projects/${projectSlug}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ daily_budget_container_seconds: HOUR }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('/container-hours');
	});
});

describe('GET /api/container-hours', () => {
	it('adds up the projects’ monthly limits beside the allowance', async () => {
		await setHoursLimits(0, 0, 40 * HOUR);
		const res = await app.request('/api/container-hours', { headers: authHeader(token) });
		expect(res.status).toBe(200);
		const { data } = await res.json();
		expect(data.project_limits).toEqual({ limited_projects: 1, monthly_seconds: 40 * HOUR });
	});
});
