import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestTeam, projectSlugForTeamSlug } from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let projectSlug: string;
let teamId: string;
let engineerId: string;
let captainId: string;

/** Insert a finished run of `minutes`, starting `daysAgo` days back. */
async function seedRun(
	memberId: string,
	daysAgo: number,
	minutes: number,
	opts?: { taskId?: string | null },
): Promise<void> {
	await db.query(
		`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at, finished_at)
		 VALUES ($1, $2, $3, 'succeeded'::heartbeat_run_status,
		         now() - ($4::int * interval '1 day'),
		         now() - ($4::int * interval '1 day') + ($5::int * interval '1 minute'))`,
		[memberId, teamId, opts?.taskId ?? null, daysAgo, minutes],
	);
}

interface HoursResponse {
	bucket: string;
	buckets: Array<{ bucket: string; agent_id: string; seconds: number; run_count: number }>;
	agents: Array<{
		agent_id: string;
		agent_title: string;
		today_seconds: number;
		week_seconds: number;
		month_seconds: number;
		month_runs: number;
	}>;
	totals: {
		today_seconds: number;
		month_seconds: number;
		month_runs: number;
		prev_week_seconds: number;
		active_today: number;
	};
}

async function fetchHours(bucket?: string): Promise<HoursResponse> {
	const query = bucket ? `?bucket=${bucket}` : '';
	const res = await app.request(`/api/projects/${projectSlug}/agent-hours${query}`, {
		headers: authHeader(token),
	});
	expect(res.status).toBe(200);
	return (await res.json()).data;
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const templates = (await typesRes.json()).data as Array<{ id: string; name: string }>;
	const teamRes = await createTestTeam(db, {
		name: 'Hours Co',
		template_id: templates.find((t) => t.name === 'App Team')?.id,
	});
	const teamSlug = (await teamRes.json()).data.slug;
	const team = await db.query<{ id: string }>('SELECT id FROM teams WHERE slug = $1', [teamSlug]);
	teamId = team.rows[0].id;
	projectSlug = await projectSlugForTeamSlug(db, teamSlug);

	const agentsRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		headers: authHeader(token),
	});
	const agents = (await agentsRes.json()).data as Array<{ id: string; slug: string }>;
	engineerId = agents.find((a) => a.slug === 'engineer')?.id as string;
	captainId = agents.find((a) => a.slug === 'captain')?.id as string;
	expect(engineerId).toBeTruthy();
	expect(captainId).toBeTruthy();

	// Today: engineer 30m + 15m, captain 20m. `daysAgo: 0` keeps every row inside
	// the day, week and month windows at once, whatever day the suite runs on.
	await seedRun(engineerId, 0, 30);
	await seedRun(engineerId, 0, 15);
	await seedRun(captainId, 0, 20);
	// A run that never finished: it has no duration, so it must not be counted -
	// nor priced as a zero that drags the average down.
	await db.query(
		`INSERT INTO heartbeat_runs (member_id, team_id, status, started_at)
		 VALUES ($1, $2, 'running'::heartbeat_run_status, now())`,
		[engineerId, teamId],
	);
});

afterAll(async () => {
	await safeClose(db);
});

describe('GET /projects/:projectId/agent-hours', () => {
	it('sums finished wall-clock time per agent and ignores unfinished runs', async () => {
		const data = await fetchHours();

		const engineer = data.agents.find((a) => a.agent_id === engineerId);
		expect(engineer?.today_seconds).toBe(45 * 60);
		expect(engineer?.month_runs).toBe(2);

		const captain = data.agents.find((a) => a.agent_id === captainId);
		expect(captain?.today_seconds).toBe(20 * 60);
		expect(captain?.month_runs).toBe(1);
	});

	it('orders agents by month-to-date time, largest first', async () => {
		const data = await fetchHours();
		expect(data.agents[0].agent_id).toBe(engineerId);
		expect(data.agents.map((a) => a.month_seconds)).toEqual(
			[...data.agents.map((a) => a.month_seconds)].sort((a, b) => b - a),
		);
	});

	it('totals across the roster, counting only agents that ran', async () => {
		const data = await fetchHours();
		expect(data.totals.today_seconds).toBe(65 * 60);
		expect(data.totals.month_runs).toBe(3);
		expect(data.totals.active_today).toBe(2);
		// A fresh team has no history, so the fixture cannot have spent last week.
		expect(data.totals.prev_week_seconds).toBe(0);
	});

	it('buckets the series and lets every bucket size through', async () => {
		for (const bucket of ['day', 'week', 'month']) {
			const data = await fetchHours(bucket);
			expect(data.bucket).toBe(bucket);
			// Every seeded run is today, so each size collapses to a single bucket
			// per agent - and the seconds must survive the regrouping unchanged.
			const engineerCells = data.buckets.filter((b) => b.agent_id === engineerId);
			expect(engineerCells.length).toBe(1);
			expect(engineerCells[0].seconds).toBe(45 * 60);
			expect(engineerCells[0].run_count).toBe(2);
			expect(engineerCells[0].bucket).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		}
	});

	// The bucket is interpolated into `date_trunc`, not bound - the allowlist is
	// what makes that safe, so it has to actually reject.
	it('rejects a bucket size it does not recognise', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/agent-hours?bucket=year`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(400);
	});

	it('rejects a caller with no token', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/agent-hours`);
		expect(res.status).toBe(401);
	});

	it('scopes to the project, so another team sees none of these hours', async () => {
		const otherTeam = await createTestTeam(db, { name: 'Other Co' });
		const otherSlug = await projectSlugForTeamSlug(db, (await otherTeam.json()).data.slug);
		const res = await app.request(`/api/projects/${otherSlug}/agent-hours`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const data = (await res.json()).data as HoursResponse;
		expect(data.agents).toEqual([]);
		expect(data.totals.month_seconds).toBe(0);
	});
});
