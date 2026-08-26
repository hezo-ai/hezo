/**
 * Reading the container-hours ledger: the windowed series the Budget page's
 * Hours tab draws, and the month-to-date figure the admission check enforces
 * against.
 *
 * Separate from `sandbox/uptime-ledger.ts`, which only ever writes. They are
 * different jobs with different callers - the writer sits inside the pool's own
 * state transitions and must stay tiny, while this is read by two routes and by
 * the capacity gate, and the clipping arithmetic below has to be identical for
 * all three or the meter and the cap disagree about the same month.
 *
 * **Overlapping intervals are summed, and that is correct.** Two containers up
 * for one hour genuinely is two container-hours - which is exactly what a
 * provider bills and exactly where the old per-agent "hours" figure went wrong,
 * since it merged concurrent runs that shared one container.
 */

import { HOURS_BUCKET_SPAN, type HoursBucket } from '@hezo/shared';
import type { Db } from '../db/database';

/**
 * Seconds of one interval that fall inside one window, as a SQL expression.
 *
 * **This is the whole point of the module.** An interval that spans a window
 * boundary must be *split* across the windows it touches, not attributed whole
 * to the one it started in - `agent-hours.ts` attributes by start, which is
 * harmless for a run measured in minutes and wrong for a month boundary on a
 * figure that gets invoiced.
 *
 * `COALESCE(ended_at, now())` bills an open interval up to this instant: a
 * container that is up right now is accruing, and showing it as zero until it
 * stops would make the current bucket read empty for as long as anything is
 * running in it.
 *
 * `GREATEST(..., 0)` guards the degenerate row rather than trusting the join:
 * an interval closed in the same statement that opened it can produce a
 * negative width under clock skew, and one negative row silently subtracts from
 * a bill.
 *
 * **The `IS NULL` guard is load-bearing on a LEFT JOIN, and its absence is
 * invisible.** On a bucket that matches no interval, every column of `alias` is
 * NULL - and the two guards above then conspire: `COALESCE(ended_at, now())`
 * reads the missing row as an interval that is *still running*, and `GREATEST`
 * ignores NULL arguments rather than returning NULL, so the missing start
 * becomes the bucket start. The expression then returns a full bucket of uptime
 * for a bucket in which nothing ran. Guarding here rather than at each call site
 * is deliberate: this is a silent wrong number rather than an error, and the
 * next LEFT JOIN written against this helper would reintroduce it.
 *
 * `alias` is the alias of `container_uptime_entries` in the surrounding query;
 * `from`/`to` are SQL expressions for the window bounds.
 */
function clippedSeconds(alias: string, from: string, to: string): string {
	return `CASE WHEN ${alias}.id IS NULL THEN NULL ELSE GREATEST(EXTRACT(EPOCH FROM (
		LEAST(COALESCE(${alias}.ended_at, now()), ${to})
		- GREATEST(${alias}.started_at, ${from})
	)), 0) END`;
}

/** Whether an interval touches a window at all - the join predicate for the above. */
function overlapsWindow(alias: string, from: string, to: string): string {
	return `${alias}.started_at < ${to} AND COALESCE(${alias}.ended_at, now()) > ${from}`;
}

/** One bucket of the hours series. */
export interface ContainerHoursBucket {
	bucket: string;
	seconds: number;
}

/** One project's share of the instance-wide series, for the stacked view. */
export interface ContainerHoursProjectBucket extends ContainerHoursBucket {
	project_id: string | null;
	project_name: string;
	project_slug: string | null;
}

export interface ContainerHoursTotals {
	today_seconds: number;
	week_seconds: number;
	month_seconds: number;
	prev_month_seconds: number;
	/** Stretches still open right now - containers currently accruing. */
	open_intervals: number;
}

/**
 * The bucket grid, as a CTE.
 *
 * `generate_series` rather than grouping the rows themselves, for two reasons:
 * it is what makes splitting possible (each interval is joined against every
 * bucket it overlaps), and it emits buckets with no activity, so a chart of a
 * quiet week shows a quiet week instead of a gap.
 *
 * Interpolated, never parameterised: `date_trunc`'s field and an `interval`
 * literal are neither of them bind slots. `isHoursBucket` upstream is the
 * allowlist that makes that safe, and `span` is a number from a constant table.
 */
function bucketGridSql(bucket: HoursBucket, span: number): string {
	return `buckets AS (
		SELECT gs AS bucket_start, gs + interval '1 ${bucket}' AS bucket_end
		  FROM generate_series(
		         date_trunc('${bucket}', now() AT TIME ZONE 'UTC') - ${span - 1} * interval '1 ${bucket}',
		         date_trunc('${bucket}', now() AT TIME ZONE 'UTC'),
		         interval '1 ${bucket}'
		       ) AS gs
	)`;
}

/**
 * Container-seconds per bucket for one project, or instance-wide when
 * `projectId` is null.
 */
export async function containerHoursSeries(
	db: Db,
	bucket: HoursBucket,
	projectId: string | null,
): Promise<ContainerHoursBucket[]> {
	const span = HOURS_BUCKET_SPAN[bucket];
	const scope = projectId === null ? '' : 'AND e.project_id = $1';
	const res = await db.query<{ bucket: string; seconds: number }>(
		`WITH ${bucketGridSql(bucket, span)}
		 SELECT b.bucket_start::date::text AS bucket,
		        COALESCE(SUM(${clippedSeconds('e', 'b.bucket_start', 'b.bucket_end')}), 0)::int AS seconds
		   FROM buckets b
		   LEFT JOIN container_uptime_entries e
		     ON ${overlapsWindow('e', 'b.bucket_start', 'b.bucket_end')}
		     ${scope}
		  GROUP BY b.bucket_start
		  ORDER BY b.bucket_start`,
		projectId === null ? [] : [projectId],
	);
	return res.rows;
}

/**
 * The instance-wide series split by project, for the stacked chart.
 *
 * A deleted project's hours survive as a null `project_id` (the FK is ON DELETE
 * SET NULL, mirroring `cost_entries`) and are reported under one "Deleted
 * projects" heading rather than dropped - they were billed either way, and
 * silently losing them makes the chart disagree with the invoice.
 */
export async function containerHoursByProject(
	db: Db,
	bucket: HoursBucket,
): Promise<ContainerHoursProjectBucket[]> {
	const span = HOURS_BUCKET_SPAN[bucket];
	const res = await db.query<ContainerHoursProjectBucket>(
		`WITH ${bucketGridSql(bucket, span)}
		 SELECT b.bucket_start::date::text AS bucket,
		        e.project_id,
		        COALESCE(p.name, 'Deleted projects') AS project_name,
		        p.slug AS project_slug,
		        COALESCE(SUM(${clippedSeconds('e', 'b.bucket_start', 'b.bucket_end')}), 0)::int AS seconds
		   FROM buckets b
		   -- INNER, unlike the series above: an empty bucket has no project to name,
		   -- and a row of nulls would render as a phantom project in the legend.
		   JOIN container_uptime_entries e
		     ON ${overlapsWindow('e', 'b.bucket_start', 'b.bucket_end')}
		   LEFT JOIN projects p ON p.id = e.project_id
		  GROUP BY b.bucket_start, e.project_id, p.name, p.slug
		  ORDER BY b.bucket_start, seconds DESC`,
	);
	return res.rows;
}

/**
 * The three window totals plus last month's, in one query.
 *
 * The same UTC boundaries as `agent-hours.ts` and `budget-status`, so an hours
 * figure and a spend figure for "this week" always cover the same week.
 */
export async function containerHoursTotals(
	db: Db,
	projectId: string | null,
): Promise<ContainerHoursTotals> {
	const scope = projectId === null ? '' : 'AND e.project_id = $1';
	const day = `date_trunc('day', now() AT TIME ZONE 'UTC')`;
	const week = `date_trunc('week', now() AT TIME ZONE 'UTC')`;
	const month = `date_trunc('month', now() AT TIME ZONE 'UTC')`;
	const prevMonth = `(${month} - interval '1 month')`;
	const res = await db.query<ContainerHoursTotals>(
		`SELECT
		   COALESCE(SUM(${clippedSeconds('e', day, 'now()')}), 0)::int   AS today_seconds,
		   COALESCE(SUM(${clippedSeconds('e', week, 'now()')}), 0)::int  AS week_seconds,
		   COALESCE(SUM(${clippedSeconds('e', month, 'now()')}), 0)::int AS month_seconds,
		   COALESCE(SUM(${clippedSeconds('e', prevMonth, month)}), 0)::int AS prev_month_seconds,
		   count(*) FILTER (WHERE e.ended_at IS NULL)::int              AS open_intervals
		 FROM container_uptime_entries e
		 -- Bounded by the widest window any column above reads, so the scan stays
		 -- on the index range rather than the whole table as the ledger grows.
		 WHERE ${overlapsWindow('e', prevMonth, 'now()')}
		   ${scope}`,
		projectId === null ? [] : [projectId],
	);
	return (
		res.rows[0] ?? {
			today_seconds: 0,
			week_seconds: 0,
			month_seconds: 0,
			prev_month_seconds: 0,
			open_intervals: 0,
		}
	);
}

/**
 * Instance-wide container-seconds so far this calendar month - what the hours
 * cap is enforced against.
 *
 * Its own narrow query rather than a field off {@link containerHoursTotals}:
 * this one runs on the container-admission path, where the other five columns
 * would be work done per dispatch and thrown away.
 */
export async function monthToDateContainerSeconds(db: Db): Promise<number> {
	const month = `date_trunc('month', now() AT TIME ZONE 'UTC')`;
	const res = await db.query<{ seconds: number }>(
		`SELECT COALESCE(SUM(${clippedSeconds('e', month, 'now()')}), 0)::int AS seconds
		   FROM container_uptime_entries e
		  WHERE ${overlapsWindow('e', month, 'now()')}`,
	);
	return res.rows[0]?.seconds ?? 0;
}
