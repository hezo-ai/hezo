/**
 * Seeding the container-hours ledger against the window it will be billed in.
 *
 * `services/container-hours.ts` counts only the part of a stretch that has
 * already happened inside the window it was asked about. A seed written as a
 * flat `now() - interval '1 hour'` therefore banks 51 minutes of *last* month
 * during the first hour of a new one, and a fixed `3600` expectation reads that
 * clipping as a bug - a whole-suite failure every month, on the release PR that
 * happens to land just after midnight UTC.
 *
 * Every seed here is cut to the month so far and hands back the seconds it
 * really banks, so the assertion built on it holds at any hour of any day.
 */

import type { Db } from '../../src/db/database';

/** The reader's own month boundary, so seed and assertion cannot drift apart. */
const MONTH_START = `date_trunc('month', now() AT TIME ZONE 'UTC')`;

/**
 * Whole seconds of the current UTC month already elapsed - the widest stretch a
 * single container can have banked in it so far.
 */
async function monthWindowSeconds(db: Db): Promise<number> {
	const res = await db.query<{ seconds: number }>(
		`SELECT floor(EXTRACT(EPOCH FROM (now() - ${MONTH_START})))::int AS seconds`,
	);
	const seconds = res.rows[0]?.seconds ?? 0;
	if (seconds <= 0) {
		throw new Error(
			'the UTC month is under a second old - no container time can have been banked in it yet',
		);
	}
	return seconds;
}

export interface UptimeStretchOptions {
	/** One row per container, every one of them over the same span. */
	containers: string[];
	/** How long the span is, at most: it is cut to the month so far. */
	minutes: number;
	projectId?: string | null;
	/** Held by the assistant chat rather than by task work. */
	chat?: boolean;
	/** Leave it running - `ended_at` stays null and the reader bills it to now. */
	open?: boolean;
}

/**
 * Seed one stretch per container, all of them over the same span.
 *
 * Returns the seconds that span banks this month, so a caller asserts
 * `n * width` rather than a figure that only holds mid-month. For an open
 * stretch that is what it had banked at seeding time, which only grows.
 */
export async function seedUptimeStretch(db: Db, opts: UptimeStretchOptions): Promise<number> {
	const window = await monthWindowSeconds(db);
	const seconds = Math.min(opts.minutes * 60, window);
	const ids = opts.containers.map((_, i) => `$${i + 5}`).join(', ');
	const res = await db.query<{ seconds: number }>(
		// `date_trunc('second', ...)` on both ends: a whole-second span banks a whole
		// number of seconds, so the width returned here and the reader's own
		// `SUM(...)::int` cannot disagree by a rounded half.
		`WITH span AS (
		   SELECT date_trunc('second', now()) - ($2::int * interval '1 second') AS started_at,
		          date_trunc('second', now()) AS ended_at
		 )
		 INSERT INTO container_uptime_entries
		     (project_id, container_id, started_at, ended_at, reserved_for_chat, backend)
		 SELECT $1, c, span.started_at,
		        CASE WHEN $3::bool THEN NULL ELSE span.ended_at END, $4::bool, 'docker'
		   FROM span, unnest(ARRAY[${ids}]::text[]) AS c
		 RETURNING floor(EXTRACT(EPOCH FROM (COALESCE(ended_at, now()) - started_at)))::int AS seconds`,
		[opts.projectId ?? null, seconds, opts.open === true, opts.chat === true, ...opts.containers],
	);
	return res.rows[0]?.seconds ?? 0;
}

/** How many concurrent stretches one seed may take before it is a mistake. */
const MAX_STRETCHES = 5_000;

/**
 * Seed exactly `seconds` of container time banked so far this month.
 *
 * Container-seconds sum across containers, so ten hours of them fit inside the
 * first ten minutes of a month - as sixty containers, which is how a fleet
 * spends them. One long stretch instead would run past `now()`, where the meter
 * stops, and a cap enforced against the month-to-date figure would never trip.
 */
export async function seedMonthToDateSeconds(
	db: Db,
	seconds: number,
	opts: { projectId?: string | null; chat?: boolean } = {},
): Promise<void> {
	if (seconds <= 0) return;
	const window = await monthWindowSeconds(db);
	const stretches = Math.ceil(seconds / window);
	if (stretches > MAX_STRETCHES) {
		throw new Error(
			`${seconds}s needs ${stretches} concurrent stretches to fit in the ${window}s of this month so far - seed less, or seed it as one stretch and assert the clipped figure`,
		);
	}
	await db.query(
		// Every stretch starts at the month boundary and the last one is short, so
		// the total is exact rather than a multiple of the window.
		`INSERT INTO container_uptime_entries
		     (project_id, container_id, started_at, ended_at, reserved_for_chat, backend)
		 SELECT $1, 'ctr-' || gen_random_uuid()::text, ${MONTH_START},
		        ${MONTH_START} + LEAST($2::int, $3::int - (g - 1) * $2::int) * interval '1 second',
		        $4, 'docker'
		   FROM generate_series(1, $5::int) AS g`,
		[opts.projectId ?? null, window, seconds, opts.chat === true, stretches],
	);
}
