/**
 * Reading the container-hours ledger: the windowed series the Budget page's
 * Hours tab draws, and the window-to-date figure the admission check enforces
 * against.
 *
 * Separate from `sandbox/uptime-ledger.ts`, which only ever writes. They are
 * different jobs with different callers - the writer sits inside the pool's own
 * state transitions and must stay tiny, while this is read by two routes and by
 * the capacity gate, and the clipping arithmetic below has to be identical for
 * all three or the meter and the cap disagree about the same window - which is
 * exactly what happened once the window stopped always being a calendar month.
 *
 * **Overlapping intervals are summed, and that is correct.** Two containers up
 * for one hour genuinely is two container-hours - which is exactly what a
 * provider bills and exactly where the old per-agent "hours" figure went wrong,
 * since it merged concurrent runs that shared one container.
 */

import {
	containerHoursWindow,
	containerHoursWindowStart,
	HOURS_BUCKET_SPAN,
	type HoursBucket,
	previousContainerHoursWindowStart,
} from '@hezo/shared';
import type { Db } from '../db/database';
import { pinnedSetting } from '../lib/system-meta';

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

/** One bucket of the hours series. `chat_seconds` is the part the assistant chat held. */
export interface ContainerHoursBucket {
	bucket: string;
	seconds: number;
	chat_seconds: number;
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
	/**
	 * So far this container-hours window - the figure the cap is enforced
	 * against.
	 *
	 * **Not a month, and named so it cannot be read as one.** A deployer may
	 * anchor the window to a billing day, and a column called `month_seconds`
	 * against a cap measured over an anchored window is a meter that disagrees
	 * with the gate beside it: anchored on the 20th, a tenant was refused a
	 * container while the bar read a third full.
	 */
	window_seconds: number;
	window_chat_seconds: number;
	/** The window before this one, whole, so the page can say which way it went. */
	prev_window_seconds: number;
	/** Stretches still open right now - containers currently accruing. */
	open_intervals: number;
	/** When this window opened and when it ends, so a reader can name the period. */
	window_start: string;
	window_end: string;
}

/** What the query yields: the sums alone, before the bounds are attached. */
type WindowedTotals = Omit<ContainerHoursTotals, 'window_start' | 'window_end'>;

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
	const res = await db.query<{ bucket: string; seconds: number; chat_seconds: number }>(
		`WITH ${bucketGridSql(bucket, span)}
		 SELECT b.bucket_start::date::text AS bucket,
		        COALESCE(SUM(${clippedSeconds('e', 'b.bucket_start', 'b.bucket_end')}), 0)::int AS seconds,
		        COALESCE(SUM(${clippedSeconds('e', 'b.bucket_start', 'b.bucket_end')})
		          FILTER (WHERE e.reserved_for_chat), 0)::int AS chat_seconds
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
		        COALESCE(SUM(${clippedSeconds('e', 'b.bucket_start', 'b.bucket_end')}), 0)::int AS seconds,
		        COALESCE(SUM(${clippedSeconds('e', 'b.bucket_start', 'b.bucket_end')})
		          FILTER (WHERE e.reserved_for_chat), 0)::int AS chat_seconds
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
	// **The same bounds the cap is enforced on**, from the one clamped helper, so
	// the meter and the gate can never name different periods. Computed here
	// rather than written into the SQL because the clamp - an anchor on the 31st,
	// in a month that has no 31st - is arithmetic `date_trunc` cannot express.
	const now = new Date();
	const anchor = pinnedSetting('containerHoursAnchorDay');
	const { start, end } = containerHoursWindow(anchor, now);
	const prevStart = previousContainerHoursWindowStart(anchor, now);

	const scope = projectId === null ? '' : 'AND e.project_id = $3';
	const day = `date_trunc('day', now() AT TIME ZONE 'UTC')`;
	const week = `date_trunc('week', now() AT TIME ZONE 'UTC')`;
	const from = '$1::timestamptz';
	const prevFrom = '$2::timestamptz';
	const params: unknown[] = [start.toISOString(), prevStart.toISOString()];
	if (projectId !== null) params.push(projectId);

	const res = await db.query<WindowedTotals>(
		`SELECT
		   COALESCE(SUM(${clippedSeconds('e', day, 'now()')}), 0)::int   AS today_seconds,
		   COALESCE(SUM(${clippedSeconds('e', week, 'now()')}), 0)::int  AS week_seconds,
		   COALESCE(SUM(${clippedSeconds('e', from, 'now()')}), 0)::int  AS window_seconds,
		   COALESCE(SUM(${clippedSeconds('e', from, 'now()')})
		     FILTER (WHERE e.reserved_for_chat), 0)::int                 AS window_chat_seconds,
		   COALESCE(SUM(${clippedSeconds('e', prevFrom, from)}), 0)::int AS prev_window_seconds,
		   count(*) FILTER (WHERE e.ended_at IS NULL)::int              AS open_intervals
		 FROM container_uptime_entries e
		 -- Bounded by the widest window any column above reads, so the scan stays
		 -- on the index range rather than the whole table as the ledger grows.
		 WHERE ${overlapsWindow('e', prevFrom, 'now()')}
		   ${scope}`,
		params,
	);

	const row: WindowedTotals = res.rows[0] ?? {
		today_seconds: 0,
		week_seconds: 0,
		window_seconds: 0,
		window_chat_seconds: 0,
		prev_window_seconds: 0,
		open_intervals: 0,
	};
	// The bounds are the caller's answer as much as the sums are: a page that adds
	// a month to the start would disagree with the gate in every short month.
	return { ...row, window_start: start.toISOString(), window_end: end.toISOString() };
}

/**
 * Instance-wide container-seconds so far this window - what the hours cap is
 * enforced against.
 *
 * **The calendar month unless a deployer pinned an anchor day**, which is what
 * this has always done and what a local or self-hosted instance wants. A control
 * plane billing on the day a tenant subscribed pins that day instead, so the
 * pool covers the period the tenant is charged for rather than a calendar month
 * cutting across it.
 *
 * The boundary is computed rather than written into the SQL because the clamp -
 * a window anchored on the 31st, in a month that has no 31st - is arithmetic
 * worth testing on its own, and `date_trunc` cannot express it.
 *
 * Its own narrow query rather than a field off {@link containerHoursTotals}:
 * this one runs on the container-admission path, where the other five columns
 * would be work done per dispatch and thrown away.
 */
export async function currentWindowContainerSeconds(db: Db): Promise<number> {
	const start = containerHoursWindowStart(
		pinnedSetting('containerHoursAnchorDay'),
		new Date(),
	).toISOString();
	const res = await db.query<{ seconds: number }>(
		`SELECT COALESCE(SUM(${clippedSeconds('e', '$1::timestamptz', 'now()')}), 0)::int AS seconds
		   FROM container_uptime_entries e
		  WHERE ${overlapsWindow('e', '$1::timestamptz', 'now()')}`,
		[start],
	);
	return res.rows[0]?.seconds ?? 0;
}
