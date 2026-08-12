import {
	emptyProgressActivity,
	PROGRESS_ACTIVITY_KINDS,
	PROGRESS_ACTIVITY_PER_COLUMN,
	PROGRESS_ACTIVITY_SUMMARY_MAX,
	type ProgressActivity,
	type ProgressActivityKind,
} from '@hezo/shared';
import type { Db } from '../db/database';

/**
 * The Progress page's three recent-activity columns are split in two halves:
 *
 * - **Selection** is deterministic and lives here, in SQL, where the rules are exact — which
 *   tasks are recent, what counts as activity, when something was closed.
 * - **Judgement** is the Captain's: it is handed these candidates in its progress-update prompt,
 *   picks from them, and writes every summary line itself.
 *
 * Everything below is the first half. Each arm is a bounded, index-served candidate window (see
 * migration 049 for the indexes and why each is shaped the way it is), and every unbounded text
 * column is truncated, so neither the row count nor the row width grows with the project.
 */

/** Candidates offered per column. Deliberately above the 5 the page shows, so the Captain chooses. */
const CANDIDATES_PER_COLUMN = 10;
/** Open tasks scanned by `updated_at` before ranking. */
const ACTIONED_TASK_WINDOW = 25;
/** Recent task-scoped runs scanned for the agent-work half of the "actioned" ranking. */
const ACTIONED_RUN_WINDOW = 200;
/**
 * Closed tasks scanned before the exact close time is resolved. `updated_at >= closed_at` always
 * (the closing PATCH stamps `updated_at`, and later edits only push it out), so scanning in
 * `updated_at DESC` order and keeping the newest closes is correct, not approximate: once the
 * kept set beats the next candidate's `updated_at`, nothing unscanned can displace it. 50 sits
 * far above that crossover for any realistic project.
 */
const CLOSED_TASK_WINDOW = 50;
/** Excerpt length for the raw material handed to the Captain. */
const EXCERPT_CHARS = 200;

export interface ProgressActivityCandidate {
	identifier: string;
	title: string;
	status: string;
	/** Who is on it (actioned), who filed it (created), or who closed it (closed). */
	actor: string | null;
	/** When the activity that qualified it happened. */
	at: string | null;
	/**
	 * The task's own words — its progress summary, or its description for a freshly created task.
	 * Raw material for the Captain to write *from*; the prompt forbids copying it.
	 */
	excerpt: string | null;
}

export type ProgressActivityCandidates = Record<ProgressActivityKind, ProgressActivityCandidate[]>;

/**
 * Candidate tasks for each column, in one round trip.
 *
 * "Actioned" ranks open tasks by `GREATEST(tasks.updated_at, latest run on the task)`. **This is
 * how progress-update runs are kept out of the column, structurally rather than by a filter**: a
 * progress-update run carries no `task_id` (see `listProgressUpdateRuns`), so it cannot enter the
 * run half, and its comments live in `task_comments`, which is not an activity signal here. A
 * task the Captain merely commented on during a progress run therefore cannot surface. The one
 * accepted leak is a progress run that *edits* a task: that bumps `updated_at` and the task
 * counts as actioned — which is defensible, since it really was edited, and `tasks` carries no
 * run attribution to tell otherwise.
 *
 * "Closed" resolves each candidate's real close time from the `status_change` system comment that
 * recorded the move to `done` (`recordStatusChange` in `task-events.ts`), served per task by
 * `idx_comments_task_created`. A **re-opened** task takes its latest close; a **cascade** close
 * has a null comment author and names the real actor in `content.triggered_by_actor_id`; a task
 * with no close comment at all keeps its row and falls back to `updated_at`. `cancelled` is
 * excluded entirely — abandoned work is not an outcome the Progress page reports.
 */
export async function buildProgressActivityCandidates(
	db: Db,
	projectId: string,
	teamId: string,
): Promise<ProgressActivityCandidates> {
	const r = await db.query<{
		kind: ProgressActivityKind;
		identifier: string;
		title: string;
		status: string;
		actor: string | null;
		at: string | null;
		excerpt: string | null;
	}>(
		`WITH recent_runs AS (
		   SELECT task_id, max(started_at) AS at
		     FROM (SELECT task_id, started_at
		             FROM heartbeat_runs
		            WHERE team_id = $2 AND task_id IS NOT NULL AND started_at IS NOT NULL
		            ORDER BY started_at DESC
		            LIMIT ${ACTIONED_RUN_WINDOW}) r
		    GROUP BY task_id
		 ),
		 open_window AS (
		   SELECT id, identifier, title, status, assignee_id, progress_summary, description, updated_at
		     FROM tasks
		    WHERE project_id = $1 AND status NOT IN ('done', 'cancelled')
		    ORDER BY updated_at DESC
		    LIMIT ${ACTIONED_TASK_WINDOW}
		 ),
		 actioned AS (
		   SELECT 'actioned'::text AS kind,
		          t.identifier, t.title, t.status::text AS status,
		          -- Deliberately the role, not the display name: this feed is read by
		          -- agents (via MCP), and SHARED_INSTRUCTIONS has them match an actor
		          -- against their own role title.
		          COALESCE(ma.title, m.display_name) AS actor,
		          GREATEST(t.updated_at, COALESCE(rr.at, t.updated_at)) AS at,
		          left(COALESCE(NULLIF(t.progress_summary, ''), t.description), ${EXCERPT_CHARS}) AS excerpt
		     FROM open_window t
		     LEFT JOIN recent_runs rr ON rr.task_id = t.id
		     LEFT JOIN members m ON m.id = t.assignee_id
		     LEFT JOIN member_agents ma ON ma.id = t.assignee_id
		    ORDER BY at DESC
		    LIMIT ${CANDIDATES_PER_COLUMN}
		 ),
		 created AS (
		   SELECT 'created'::text AS kind,
		          t.identifier, t.title, t.status::text AS status,
		          COALESCE(ma.title, m.display_name) AS actor,
		          t.created_at AS at,
		          left(COALESCE(NULLIF(t.description, ''), t.progress_summary), ${EXCERPT_CHARS}) AS excerpt
		     FROM tasks t
		     LEFT JOIN members m ON m.id = t.created_by_member_id
		     LEFT JOIN member_agents ma ON ma.id = t.created_by_member_id
		    WHERE t.project_id = $1
		    ORDER BY t.created_at DESC
		    LIMIT ${CANDIDATES_PER_COLUMN}
		 ),
		 done_window AS (
		   SELECT id, identifier, title, status, progress_summary, description, updated_at
		     FROM tasks
		    WHERE project_id = $1 AND status = 'done'
		    ORDER BY updated_at DESC
		    LIMIT ${CLOSED_TASK_WINDOW}
		 ),
		 closed AS (
		   SELECT 'closed'::text AS kind,
		          t.identifier, t.title, t.status::text AS status,
		          COALESCE(ma.title, m.display_name) AS actor,
		          COALESCE(cc.created_at, t.updated_at) AS at,
		          left(COALESCE(NULLIF(t.progress_summary, ''), t.description), ${EXCERPT_CHARS}) AS excerpt
		     FROM done_window t
		     LEFT JOIN LATERAL (
		       SELECT c.created_at,
		              COALESCE(c.author_member_id, (c.content->>'triggered_by_actor_id')::uuid) AS actor_id
		         FROM task_comments c
		        WHERE c.task_id = t.id
		          AND c.content_type = 'system'::comment_content_type
		          AND c.content->>'kind' = 'status_change'
		          AND c.content->>'to' = 'done'
		        ORDER BY c.created_at DESC
		        LIMIT 1
		     ) cc ON true
		     LEFT JOIN members m ON m.id = cc.actor_id
		     LEFT JOIN member_agents ma ON ma.id = cc.actor_id
		    ORDER BY at DESC
		    LIMIT ${CANDIDATES_PER_COLUMN}
		 )
		 SELECT * FROM actioned
		 UNION ALL SELECT * FROM created
		 UNION ALL SELECT * FROM closed`,
		[projectId, teamId],
	);

	const out: ProgressActivityCandidates = { actioned: [], created: [], closed: [] };
	for (const row of r.rows) {
		out[row.kind]?.push({
			identifier: row.identifier,
			title: row.title,
			status: row.status,
			actor: row.actor,
			at: row.at,
			excerpt: row.excerpt || null,
		});
	}
	return out;
}

export interface ProgressActivityInput {
	task: string;
	summary: string;
}

/**
 * Trim a Captain-written activity line to `max` characters **at a sentence boundary**, so what is
 * stored is always a finished thought. The page renders the stored line in full - there is no
 * clamp or ellipsis to hide a mid-clause cut behind - so a blind slice would surface as a sentence
 * that simply stops.
 *
 * A boundary is terminal punctuation followed by the start of another sentence (whitespace, then a
 * capital or an opening quote) or by the end of the budget, which keeps an abbreviation like "e.g."
 * from reading as an ending. When nothing finishes inside the budget - a run-on far longer than the
 * one line the prompt asks for - the cut falls back to the last whole word, and then to a hard
 * slice for text carrying no spaces at all.
 */
export function clampToWholeSentence(text: string, max: number): string {
	const trimmed = text.trim();
	if (trimmed.length <= max) return trimmed;
	const window = trimmed.slice(0, max);
	let cut = 0;
	for (const m of window.matchAll(/[.!?]["'’”)\]]*(?=$|\s+["'“([]?[A-Z0-9])/g)) {
		cut = (m.index ?? 0) + m[0].length;
	}
	if (cut > 0) return window.slice(0, cut);
	const lastSpace = window.lastIndexOf(' ');
	return (lastSpace > 0 ? window.slice(0, lastSpace) : window).trimEnd();
}

export interface ProgressActivitySnapshot {
	activity: ProgressActivity;
	/** Identifiers the Captain named that do not resolve in this project, reported back to it. */
	unknown: string[];
}

/**
 * Validate the Captain's three lists into the document stored on the project.
 *
 * Resolution happens once, here on write, so reads need no task lookup at all: the identifier and
 * title are captured into the snapshot. Unknown identifiers are collected rather than silently
 * dropped, so the tool can tell the Captain it named a task that does not exist instead of the
 * row quietly vanishing from the page.
 */
export async function buildProgressActivitySnapshot(
	db: Db,
	projectId: string,
	lists: Partial<Record<ProgressActivityKind, ProgressActivityInput[]>>,
): Promise<ProgressActivitySnapshot> {
	const activity = emptyProgressActivity();
	const unknown: string[] = [];

	// One lookup for every identifier named across all three lists.
	const named = new Set<string>();
	for (const kind of PROGRESS_ACTIVITY_KINDS) {
		for (const entry of lists[kind] ?? []) {
			if (entry?.task) named.add(entry.task.trim().toUpperCase());
		}
	}
	if (named.size === 0) return { activity, unknown };

	const found = await db.query<{ identifier: string; title: string }>(
		`SELECT identifier, title FROM tasks
		  WHERE project_id = $1 AND UPPER(identifier) = ANY($2::text[])`,
		[projectId, [...named]],
	);
	const byIdentifier = new Map(found.rows.map((row) => [row.identifier.toUpperCase(), row]));

	for (const kind of PROGRESS_ACTIVITY_KINDS) {
		for (const entry of lists[kind] ?? []) {
			if (activity[kind].length >= PROGRESS_ACTIVITY_PER_COLUMN) break;
			const key = entry?.task?.trim().toUpperCase();
			const summary = entry?.summary?.trim();
			if (!key || !summary) continue;
			const task = byIdentifier.get(key);
			if (!task) {
				if (!unknown.includes(key)) unknown.push(key);
				continue;
			}
			activity[kind].push({
				identifier: task.identifier,
				title: task.title,
				summary: clampToWholeSentence(summary, PROGRESS_ACTIVITY_SUMMARY_MAX),
			});
		}
	}
	return { activity, unknown };
}

/**
 * Coerce a stored `progress_activity` value into the shape the API returns. The column defaults
 * to `{}` (migration 049), and a project that has never had a progress-update run keeps it, so
 * every read has to tolerate a partial or absent document.
 */
export function readProgressActivity(value: unknown): ProgressActivity {
	const activity = emptyProgressActivity();
	if (!value || typeof value !== 'object') return activity;
	const raw = value as Record<string, unknown>;
	for (const kind of PROGRESS_ACTIVITY_KINDS) {
		const list = raw[kind];
		if (!Array.isArray(list)) continue;
		for (const item of list.slice(0, PROGRESS_ACTIVITY_PER_COLUMN)) {
			if (!item || typeof item !== 'object') continue;
			const { identifier, title, summary } = item as Record<string, unknown>;
			if (typeof identifier !== 'string' || typeof summary !== 'string') continue;
			activity[kind].push({
				identifier,
				title: typeof title === 'string' ? title : identifier,
				summary,
			});
		}
	}
	return activity;
}
