import type { Db } from '../db/database';

/**
 * Deterministic raw material for the Coach's retrospective: the structural shape of
 * a project's recent work, as numbers rather than prose.
 *
 * Server-internal prompt scaffolding, not a wire type - nothing outside a
 * retrospective run's prompt ever sees these. Deliberately **not** an MCP tool: run
 * economics are kept out of agents' hands on purpose (see the "No MCP twin" notes on
 * `routes/agent-hours.ts` and `routes/container-hours.ts` - "an agent asking how long
 * it has been running would act on a figure it cannot change"). A block the server
 * composes for one run kind reaches exactly one agent on one run, is not addressable
 * and cannot be re-queried, so the boundary those routes draw stays where it is.
 *
 * What this exists to catch, and why it is measured rather than read: one project
 * spent 1.78 billion input tokens in seven days on a verification loop that never
 * converged, and the Coach reviewed 60 of those tasks one at a time, across 65 runs,
 * without flagging it. No single task was wrong. The loop was only visible in how the
 * work multiplied - 58 near-identical tasks, one of them run 31 times in 17 hours, an
 * asset library that grew 70% in a week. Prose review cannot see that; counting can.
 *
 * Every arm is a bounded, index-served window (migration 078 for the two indexes this
 * needed, 049 and 060 for the ones it reuses), and every text column is truncated in
 * the query, so neither row count nor row width grows with the project.
 *
 * The window is a parameter and this module holds no view on how often it is called.
 * The queries are three indexed aggregates costing almost nothing; only the Coach run
 * they feed is expensive. Keeping the two separate is what lets the cadence move
 * without touching any of this.
 */

/** Tasks reported by burn. Ranked by tokens, which is the signal; runs is context. */
const RETRO_TASK_BURN_ROWS = 10;
/** Parents reported for fan-out. */
const RETRO_FAN_OUT_ROWS = 5;
/** Near-duplicate title clusters reported, and identifiers listed per cluster. */
const RETRO_TITLE_CLUSTER_ROWS = 5;
const RETRO_CLUSTER_IDENTIFIERS = 8;
/** Repeatedly-rewritten asset name stems reported. */
const RETRO_ASSET_REPEAT_ROWS = 5;
/** Tasks a previous retrospective already commented on. */
const RETRO_FLAGGED_ROWS = 20;
/**
 * Title width. Truncated in SQL rather than after the fetch: the rule is to bound a
 * read in row width as well as row count, and a task description can be arbitrarily
 * long.
 */
const RETRO_TITLE_CHARS = 120;
/**
 * Words a title is reduced to when clustering near-duplicates.
 *
 * Four is what separated signal from noise on the real data: it collapsed 21 copies
 * of "Review team coherence after roster change" and 7 of "Independently verify
 * screening package" onto one stem each, while leaving genuinely different titles
 * apart. Fewer collapses unrelated work; more misses a cluster that varies late in
 * the title, which is exactly where a generated suffix sits.
 */
const RETRO_TITLE_STEM_WORDS = 4;
/** A cluster is only worth reporting from this many members up. */
const RETRO_MIN_CLUSTER = 3;
/** A parent is only worth reporting from this many children up. */
const RETRO_MIN_FAN_OUT = 5;
/** An artifact rewritten this many times in one window is worth reporting. */
const RETRO_MIN_REPEATS = 4;

/** One task, ranked by what it spent. */
export interface RetrospectiveTaskBurn {
	identifier: string;
	title: string;
	status: string;
	assignee: string | null;
	parent: string | null;
	runs: number;
	/** Runs that ended `failed` or `timed_out`. */
	unproductive: number;
	input_tokens: number;
	output_tokens: number;
	avg_minutes: number;
}

/** One parent and how much work it spawned. */
export interface RetrospectiveFanOut {
	parent_identifier: string;
	parent_title: string;
	children_in_window: number;
	children_total: number;
}

/** Tasks whose titles collapse to the same stem. */
export interface RetrospectiveTitleCluster {
	stem: string;
	count: number;
	identifiers: string[];
	/** Null when the rows were system-created, which is itself worth seeing. */
	creator: string | null;
}

/** One artifact rewritten repeatedly, and whether each copy grew. */
export interface RetrospectiveAssetRepeat {
	stem: string;
	copies: number;
	first_bytes: number;
	last_bytes: number;
}

export interface RetrospectiveSignals {
	window_days: number;
	window_start: string;
	totals: {
		runs: number;
		input_tokens: number;
		output_tokens: number;
		tasks_created: number;
		/**
		 * The same window across every team.
		 *
		 * The denominator, and the reason a figure means anything: "1.78 billion
		 * tokens" is alarming only next to the rest of the instance. Without it the
		 * Coach is judging a number with no scale.
		 */
		instance_input_tokens: number;
	};
	task_burn: RetrospectiveTaskBurn[];
	fan_out: RetrospectiveFanOut[];
	title_clusters: RetrospectiveTitleCluster[];
	assets: {
		added: number;
		added_bytes: number;
		total: number;
		total_bytes: number;
		ever_archived: number;
	};
	asset_repeats: RetrospectiveAssetRepeat[];
	/**
	 * Task identifiers an earlier retrospective already commented on.
	 *
	 * Structural, not a phrase: derived from the run attribution the schema already
	 * carries (`task_comments.created_by_run_id` joined to runs of this kind), so it
	 * needs no label and no new column. Overlapping windows mean a developing finding
	 * is seen several times; this is what stops it being reported several times.
	 */
	already_flagged: string[];
}

const num = (v: unknown): number => {
	const n = typeof v === 'number' ? v : Number(v ?? 0);
	return Number.isFinite(n) ? n : 0;
};

/**
 * Build the signal block for one project over the last `windowDays`.
 *
 * Four round trips, each bounded and index-served. They are kept separate rather than
 * joined because they have nothing in common but the window: one reads runs, one
 * tasks, one assets, one comments, and joining them would multiply rows for no gain.
 */
export async function buildRetrospectiveSignals(
	db: Db,
	projectId: string,
	teamId: string,
	windowDays: number,
): Promise<RetrospectiveSignals> {
	const since = `${windowDays} days`;

	// Runs: per-task burn, the project's totals, and the instance denominator. Served
	// by idx_runs_team_started (team_id, started_at) from migration 060.
	const runs = await db.query<Record<string, unknown>>(
		`WITH windowed AS (
		   SELECT r.task_id, r.status, r.input_tokens, r.output_tokens,
		          EXTRACT(epoch FROM (r.finished_at - r.started_at)) AS secs
		     FROM heartbeat_runs r
		    WHERE r.team_id = $1 AND r.started_at >= now() - ($2)::interval
		 ), per_task AS (
		   SELECT w.task_id,
		          count(*)::int AS runs,
		          count(*) FILTER (WHERE w.status IN ('failed','timed_out'))::int AS unproductive,
		          COALESCE(sum(w.input_tokens), 0)::bigint AS input_tokens,
		          COALESCE(sum(w.output_tokens), 0)::bigint AS output_tokens,
		          COALESCE(avg(w.secs), 0) / 60.0 AS avg_minutes
		     FROM windowed w WHERE w.task_id IS NOT NULL
		    GROUP BY w.task_id
		 )
		 SELECT t.identifier, left(t.title, $4) AS title, t.status::text AS status,
		        COALESCE(ma.title, m.display_name) AS assignee,
		        pt.identifier AS parent,
		        p.runs, p.unproductive, p.input_tokens, p.output_tokens,
		        round(p.avg_minutes::numeric, 1) AS avg_minutes
		   FROM per_task p
		   JOIN tasks t ON t.id = p.task_id AND t.project_id = $3
		   LEFT JOIN members m ON m.id = t.assignee_id
		   LEFT JOIN member_agents ma ON ma.id = t.assignee_id
		   LEFT JOIN tasks pt ON pt.id = t.parent_task_id
		  ORDER BY (p.input_tokens + p.output_tokens) DESC
		  LIMIT $5`,
		[teamId, since, projectId, RETRO_TITLE_CHARS, RETRO_TASK_BURN_ROWS],
	);

	const totalsRow = await db.query<Record<string, unknown>>(
		`SELECT
		   (SELECT count(*)::int FROM heartbeat_runs
		     WHERE team_id = $1 AND started_at >= now() - ($2)::interval) AS runs,
		   (SELECT COALESCE(sum(input_tokens), 0)::bigint FROM heartbeat_runs
		     WHERE team_id = $1 AND started_at >= now() - ($2)::interval) AS input_tokens,
		   (SELECT COALESCE(sum(output_tokens), 0)::bigint FROM heartbeat_runs
		     WHERE team_id = $1 AND started_at >= now() - ($2)::interval) AS output_tokens,
		   (SELECT count(*)::int FROM tasks
		     WHERE project_id = $3 AND created_at >= now() - ($2)::interval) AS tasks_created,
		   (SELECT COALESCE(sum(input_tokens), 0)::bigint FROM heartbeat_runs
		     WHERE started_at >= now() - ($2)::interval) AS instance_input_tokens`,
		[teamId, since, projectId],
	);

	// Tasks created in the window: fan-out and near-duplicate titles from one scan,
	// served by idx_tasks_project_created (project_id, created_at DESC) from 049. The
	// per-parent total is a point lookup on idx_tasks_parent per *reported* parent,
	// not per row, so the bare index on that column is sufficient here.
	const fanOut = await db.query<Record<string, unknown>>(
		`SELECT pt.identifier AS parent_identifier,
		        left(pt.title, $5) AS parent_title,
		        count(*)::int AS children_in_window,
		        (SELECT count(*)::int FROM tasks a WHERE a.parent_task_id = pt.id) AS children_total
		   FROM tasks t
		   JOIN tasks pt ON pt.id = t.parent_task_id
		  WHERE t.project_id = $1 AND t.created_at >= now() - ($2)::interval
		  GROUP BY pt.id, pt.identifier, pt.title
		 HAVING count(*) >= $3
		  ORDER BY count(*) DESC
		  LIMIT $4`,
		[projectId, since, RETRO_MIN_FAN_OUT, RETRO_FAN_OUT_ROWS, RETRO_TITLE_CHARS],
	);

	const clusters = await db.query<Record<string, unknown>>(
		`SELECT lower(array_to_string((string_to_array(t.title, ' '))[1:$3], ' ')) AS stem,
		        count(*)::int AS count,
		        (array_agg(t.identifier ORDER BY t.created_at))[1:$4] AS identifiers,
		        max(COALESCE(ma.title, m.display_name)) AS creator
		   FROM tasks t
		   LEFT JOIN members m ON m.id = t.created_by_member_id
		   LEFT JOIN member_agents ma ON ma.id = t.created_by_member_id
		  WHERE t.project_id = $1 AND t.created_at >= now() - ($2)::interval
		  GROUP BY 1
		 HAVING count(*) >= $5
		  ORDER BY count(*) DESC
		  LIMIT $6`,
		[
			projectId,
			since,
			RETRO_TITLE_STEM_WORDS,
			RETRO_CLUSTER_IDENTIFIERS,
			RETRO_MIN_CLUSTER,
			RETRO_TITLE_CLUSTER_ROWS,
		],
	);

	// Assets: window growth against the library, served by idx_assets_project_created
	// from 078. The repeats arm strips a leading folder and a leading date so the same
	// artifact rewritten under a new task's path collapses to one stem.
	const assets = await db.query<Record<string, unknown>>(
		`SELECT
		   count(*) FILTER (WHERE created_at >= now() - ($2)::interval)::int AS added,
		   COALESCE(sum(byte_size) FILTER (WHERE created_at >= now() - ($2)::interval), 0)::bigint
		     AS added_bytes,
		   count(*)::int AS total,
		   COALESCE(sum(byte_size), 0)::bigint AS total_bytes,
		   count(*) FILTER (WHERE archived_at IS NOT NULL)::int AS ever_archived
		 FROM assets WHERE project_id = $1`,
		[projectId, since],
	);

	const repeats = await db.query<Record<string, unknown>>(
		`SELECT regexp_replace(
		          regexp_replace(original_filename, '^[^/]+/', ''),
		          '^[0-9]{4}-[0-9]{2}-[0-9]{2}-?', '') AS stem,
		        count(*)::int AS copies,
		        (array_agg(byte_size ORDER BY created_at))[1] AS first_bytes,
		        (array_agg(byte_size ORDER BY created_at DESC))[1] AS last_bytes
		   FROM assets
		  WHERE project_id = $1 AND created_at >= now() - ($2)::interval
		  GROUP BY 1
		 HAVING count(*) >= $3
		  ORDER BY count(*) DESC
		  LIMIT $4`,
		[projectId, since, RETRO_MIN_REPEATS, RETRO_ASSET_REPEAT_ROWS],
	);

	const flagged = await db.query<{ identifier: string }>(
		`SELECT DISTINCT t.identifier
		   FROM task_comments c
		   JOIN heartbeat_runs r ON r.id = c.created_by_run_id
		   JOIN tasks t ON t.id = c.task_id
		  WHERE t.project_id = $1 AND r.kind = 'retrospective'::heartbeat_run_kind
		  ORDER BY t.identifier
		  LIMIT $2`,
		[projectId, RETRO_FLAGGED_ROWS],
	);

	const t = totalsRow.rows[0] ?? {};
	const a = assets.rows[0] ?? {};
	return {
		window_days: windowDays,
		window_start: new Date(Date.now() - windowDays * 86_400_000).toISOString(),
		totals: {
			runs: num(t.runs),
			input_tokens: num(t.input_tokens),
			output_tokens: num(t.output_tokens),
			tasks_created: num(t.tasks_created),
			instance_input_tokens: num(t.instance_input_tokens),
		},
		task_burn: runs.rows.map((r) => ({
			identifier: String(r.identifier),
			title: String(r.title ?? ''),
			status: String(r.status),
			assignee: (r.assignee as string | null) ?? null,
			parent: (r.parent as string | null) ?? null,
			runs: num(r.runs),
			unproductive: num(r.unproductive),
			input_tokens: num(r.input_tokens),
			output_tokens: num(r.output_tokens),
			avg_minutes: num(r.avg_minutes),
		})),
		fan_out: fanOut.rows.map((r) => ({
			parent_identifier: String(r.parent_identifier),
			parent_title: String(r.parent_title ?? ''),
			children_in_window: num(r.children_in_window),
			children_total: num(r.children_total),
		})),
		title_clusters: clusters.rows.map((r) => ({
			stem: String(r.stem ?? ''),
			count: num(r.count),
			identifiers: (r.identifiers as string[] | null) ?? [],
			creator: (r.creator as string | null) ?? null,
		})),
		assets: {
			added: num(a.added),
			added_bytes: num(a.added_bytes),
			total: num(a.total),
			total_bytes: num(a.total_bytes),
			ever_archived: num(a.ever_archived),
		},
		asset_repeats: repeats.rows.map((r) => ({
			stem: String(r.stem ?? ''),
			copies: num(r.copies),
			first_bytes: num(r.first_bytes),
			last_bytes: num(r.last_bytes),
		})),
		already_flagged: flagged.rows.map((r) => r.identifier),
	};
}
