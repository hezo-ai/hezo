import { HOURS_BUCKET_SPAN, HoursBucket, isHoursBucket } from '@hezo/shared';
import { Hono } from 'hono';
import { agentDisplayNameSql } from '../lib/agent-identity';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';

export const agentHoursRoutes = new Hono<Env>();

/** One (bucket, agent) cell of the hours series. `seconds` is summed wall clock. */
interface HoursBucketRow {
	bucket: string;
	agent_id: string;
	agent_title: string;
	agent_name: string | null;
	agent_slug: string | null;
	seconds: number;
	run_count: number;
}

interface HoursAgentRow {
	agent_id: string;
	agent_title: string;
	agent_name: string | null;
	agent_slug: string | null;
	today_seconds: number;
	week_seconds: number;
	month_seconds: number;
	month_runs: number;
}

/**
 * Per-agent wall-clock time for the project, powering the Activity page's Hours
 * tab. "Hours" is `finished_at - started_at` summed over finished runs: what the
 * agent occupied, not what it billed - the Budget page answers the money
 * question from `cost_entries` instead.
 *
 * Scope is the project's own team. Runs carry `team_id`, not `project_id`, and
 * the 1:1 project/team model makes the two equivalent - a run by an HQ singleton
 * (CEO, Coach) acting inside this project is scoped to *this* team, so it is
 * counted here and not against HQ. See AGENTS.md "Cross-team execution".
 *
 * Concurrent runs by one agent are summed rather than merged into a wall-clock
 * union: `assertNoBlockingRun` / `isTaskBusyInDb` keep one run per task, so the
 * overlap case is a rarity, and the merge would cost an interval sweep per agent
 * on every read to change a figure almost nobody sees move.
 *
 * No MCP twin, like `audit-log` and `budget-status` beside it: this is an
 * operator's read of the team, and an agent asking how long it has been running
 * would act on a figure it cannot change.
 */
agentHoursRoutes.get('/projects/:projectId/agent-hours', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');

	const requested = c.req.query('bucket') ?? HoursBucket.Day;
	if (!isHoursBucket(requested)) {
		return err(c, 'INVALID_REQUEST', `bucket must be one of day, week, month`, 400);
	}
	// Interpolated, never parameterised: `date_trunc`'s field is a literal, not a
	// bind slot. `isHoursBucket` is the allowlist that makes that safe.
	const bucket = requested;
	const span = HOURS_BUCKET_SPAN[bucket];

	// Only finished runs count - an in-flight one has no duration yet, and would
	// otherwise land in the current bucket as a zero and drag the average down.
	// The window bound is what keeps the row count bounded (span x roster).
	// `::date::text` for the same reason the cost series casts: PGlite hands a
	// Postgres `date` back as a JS Date, which serialises to a full ISO timestamp
	// and breaks the chart's date-only parsing.
	const series = await db.query<HoursBucketRow>(
		`SELECT date_trunc('${bucket}', hr.started_at)::date::text AS bucket,
		        hr.member_id AS agent_id,
		        COALESCE(ma.title, m.display_name) AS agent_title,
		        ${agentDisplayNameSql('ma', 'm')} AS agent_name,
		        ma.slug AS agent_slug,
		        COALESCE(SUM(EXTRACT(EPOCH FROM (hr.finished_at - hr.started_at))), 0)::int AS seconds,
		        count(*)::int AS run_count
		 FROM heartbeat_runs hr
		 JOIN members m ON m.id = hr.member_id
		 LEFT JOIN member_agents ma ON ma.id = hr.member_id
		 WHERE hr.team_id = $1
		   AND hr.started_at IS NOT NULL
		   AND hr.finished_at IS NOT NULL
		   AND hr.started_at >= date_trunc('${bucket}', now() AT TIME ZONE 'UTC')
		                        - ($2::int - 1) * interval '1 ${bucket}'
		 GROUP BY bucket, hr.member_id, ma.title, ma.human_name, ma.slug, m.display_name
		 ORDER BY bucket`,
		[teamId, span],
	);

	// One grouped query for every agent's three windows rather than N+1, matching
	// the shape `budget-status` uses - and the same UTC boundaries, so an hours
	// figure and a spend figure for "this week" always cover the same week.
	const agents = await db.query<HoursAgentRow>(
		`SELECT hr.member_id AS agent_id,
		        COALESCE(ma.title, m.display_name) AS agent_title,
		        ${agentDisplayNameSql('ma', 'm')} AS agent_name,
		        ma.slug AS agent_slug,
		        COALESCE(SUM(EXTRACT(EPOCH FROM (hr.finished_at - hr.started_at)))
		          FILTER (WHERE hr.started_at >= date_trunc('day',   now() AT TIME ZONE 'UTC')), 0)::int AS today_seconds,
		        COALESCE(SUM(EXTRACT(EPOCH FROM (hr.finished_at - hr.started_at)))
		          FILTER (WHERE hr.started_at >= date_trunc('week',  now() AT TIME ZONE 'UTC')), 0)::int AS week_seconds,
		        COALESCE(SUM(EXTRACT(EPOCH FROM (hr.finished_at - hr.started_at)))
		          FILTER (WHERE hr.started_at >= date_trunc('month', now() AT TIME ZONE 'UTC')), 0)::int AS month_seconds,
		        count(*) FILTER (WHERE hr.started_at >= date_trunc('month', now() AT TIME ZONE 'UTC'))::int AS month_runs
		 FROM heartbeat_runs hr
		 JOIN members m ON m.id = hr.member_id
		 LEFT JOIN member_agents ma ON ma.id = hr.member_id
		 WHERE hr.team_id = $1
		   AND hr.started_at IS NOT NULL
		   AND hr.finished_at IS NOT NULL
		   AND hr.started_at >= date_trunc('month', now() AT TIME ZONE 'UTC') - interval '1 month'
		 GROUP BY hr.member_id, ma.title, ma.human_name, ma.slug, m.display_name
		 HAVING count(*) FILTER (WHERE hr.started_at >= date_trunc('month', now() AT TIME ZONE 'UTC')) > 0
		 ORDER BY month_seconds DESC`,
		[teamId],
	);

	// The previous full week, for the week tile's delta. Its own query rather than
	// another FILTER on the one above: that query drops any agent with no
	// month-to-date runs (`HAVING`), which is exactly the agent whose last-week
	// time this needs. Roster-wide, so it aggregates in the index range scan.
	const prev = await db.query<{ prev_week_seconds: number }>(
		`SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (hr.finished_at - hr.started_at))), 0)::int AS prev_week_seconds
		 FROM heartbeat_runs hr
		 WHERE hr.team_id = $1
		   AND hr.started_at IS NOT NULL
		   AND hr.finished_at IS NOT NULL
		   AND hr.started_at >= date_trunc('week', now() AT TIME ZONE 'UTC') - interval '1 week'
		   AND hr.started_at <  date_trunc('week', now() AT TIME ZONE 'UTC')`,
		[teamId],
	);

	const rows = agents.rows;
	const sum = (pick: (row: HoursAgentRow) => number) => rows.reduce((acc, r) => acc + pick(r), 0);

	return ok(c, {
		bucket,
		buckets: series.rows,
		agents: rows,
		totals: {
			today_seconds: sum((r) => r.today_seconds),
			week_seconds: sum((r) => r.week_seconds),
			month_seconds: sum((r) => r.month_seconds),
			month_runs: sum((r) => r.month_runs),
			prev_week_seconds: prev.rows[0]?.prev_week_seconds ?? 0,
			active_today: rows.filter((r) => r.today_seconds > 0).length,
		},
	});
});
