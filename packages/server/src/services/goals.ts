import type { PGlite } from '@electric-sql/pglite';
import {
	GoalCheckFrequency as Freq,
	type GoalCheckFrequency,
	type GoalCheckRunSummary,
	type GoalHealth,
	type GoalWithProject,
	GoalHealth as Health,
	HeartbeatRunKind,
	wsRoom,
} from '@hezo/shared';
import { broadcastRowChange } from '../lib/broadcast';
import { withTransaction } from '../lib/sql';
import type { WebSocketManager } from './ws';

// Bare projection of the goals table — every column, shared by REST handlers, the MCP
// tools, and this service.
export const GOAL_COLUMNS_BARE = `id, team_id, project_id, title, measurement, actions, progress_percent,
	health, status_blurb, check_frequency, target_date, last_checked_at, archived_at,
	created_by_member_id, created_at, updated_at`;

export type GoalErrorCode = 'INVALID_REQUEST' | 'NOT_FOUND' | 'FORBIDDEN';

export class GoalError extends Error {
	readonly code: GoalErrorCode;
	constructor(code: GoalErrorCode, message: string) {
		super(message);
		this.code = code;
		this.name = 'GoalError';
	}
}

export interface CreateGoalInput {
	project_id: string;
	title: string;
	measurement?: string;
	actions?: string;
	check_frequency?: string;
	target_date?: string | null;
}

export interface CreateGoalCaller {
	actorMemberId: string | null;
}

export interface UpdateGoalInput {
	title?: string;
	measurement?: string;
	actions?: string;
	check_frequency?: string;
	target_date?: string | null;
	/** Admin-only: ISO timestamp to archive, or null to un-archive. */
	archived?: boolean;
}

export type GoalRow = Record<string, unknown> & { id: string; project_id: string };

const VALID_FREQUENCIES = new Set<string>(Object.values(Freq));

function assertFrequency(freq: string | undefined): GoalCheckFrequency {
	if (freq === undefined) return Freq.Daily;
	if (!VALID_FREQUENCIES.has(freq)) {
		throw new GoalError('INVALID_REQUEST', `Invalid check_frequency '${freq}'`);
	}
	return freq as GoalCheckFrequency;
}

/** The recent progress-history points embedded on each goal in list/detail responses. */
const HISTORY_AGG_SQL = `COALESCE((
	SELECT json_agg(h ORDER BY h.t ASC)
	FROM (
		SELECT gru.created_at AS t, gru.progress_percent AS percent, gru.health
		FROM goal_run_updates gru
		WHERE gru.goal_id = g.id
		ORDER BY gru.created_at DESC
		LIMIT 30
	) h
), '[]'::json)`;

export async function createGoal(
	db: PGlite,
	teamId: string,
	input: CreateGoalInput,
	caller: CreateGoalCaller,
	wsManager: WebSocketManager | undefined,
): Promise<GoalRow> {
	const title = input.title?.trim();
	if (!input.project_id || !title) {
		throw new GoalError('INVALID_REQUEST', 'project_id and title are required');
	}
	const frequency = assertFrequency(input.check_frequency);

	// HQ / internal projects don't have goals.
	const proj = await db.query<{ is_internal: boolean }>(
		`SELECT is_internal FROM projects WHERE id = $1 AND team_id = $2`,
		[input.project_id, teamId],
	);
	if (proj.rows.length === 0) {
		throw new GoalError('NOT_FOUND', 'Project not found');
	}
	if (proj.rows[0].is_internal) {
		throw new GoalError('FORBIDDEN', 'The HQ project does not support goals');
	}

	const r = await db.query<GoalRow>(
		`INSERT INTO goals (team_id, project_id, title, measurement, actions, check_frequency, target_date, created_by_member_id)
		 VALUES ($1, $2, $3, $4, $5, $6::goal_check_frequency, $7, $8)
		 RETURNING ${GOAL_COLUMNS_BARE}`,
		[
			teamId,
			input.project_id,
			title,
			input.measurement ?? '',
			input.actions ?? '',
			frequency,
			input.target_date ?? null,
			caller.actorMemberId,
		],
	);
	const goal = r.rows[0];
	broadcastRowChange(wsManager, wsRoom.team(teamId), 'goals', 'INSERT', goal);
	return goal;
}

export async function updateGoal(
	db: PGlite,
	teamId: string,
	goalId: string,
	input: UpdateGoalInput,
	wsManager: WebSocketManager | undefined,
): Promise<GoalRow> {
	const sets: string[] = [];
	const params: unknown[] = [];
	let idx = 1;

	if (input.title !== undefined) {
		const title = input.title.trim();
		if (!title) throw new GoalError('INVALID_REQUEST', 'title cannot be empty');
		sets.push(`title = $${idx++}`);
		params.push(title);
	}
	if (input.measurement !== undefined) {
		sets.push(`measurement = $${idx++}`);
		params.push(input.measurement);
	}
	if (input.actions !== undefined) {
		sets.push(`actions = $${idx++}`);
		params.push(input.actions);
	}
	if (input.check_frequency !== undefined) {
		sets.push(`check_frequency = $${idx++}::goal_check_frequency`);
		params.push(assertFrequency(input.check_frequency));
	}
	if (input.target_date !== undefined) {
		sets.push(`target_date = $${idx++}`);
		params.push(input.target_date);
	}
	if (input.archived !== undefined) {
		sets.push(`archived_at = ${input.archived ? 'now()' : 'NULL'}`);
	}

	if (sets.length === 0) {
		throw new GoalError('INVALID_REQUEST', 'No updatable fields provided');
	}
	sets.push('updated_at = now()');

	params.push(goalId, teamId);
	const r = await db.query<GoalRow>(
		`UPDATE goals SET ${sets.join(', ')}
		 WHERE id = $${idx++} AND team_id = $${idx}
		 RETURNING ${GOAL_COLUMNS_BARE}`,
		params,
	);
	if (r.rows.length === 0) {
		throw new GoalError('NOT_FOUND', 'Goal not found');
	}
	const goal = r.rows[0];
	broadcastRowChange(wsManager, wsRoom.team(teamId), 'goals', 'UPDATE', goal);
	return goal;
}

export async function listGoals(
	db: PGlite,
	projectId: string,
	opts: { includeArchived?: boolean } = {},
): Promise<GoalWithProject[]> {
	const where = opts.includeArchived ? '' : 'AND g.archived_at IS NULL';
	const r = await db.query<GoalWithProject>(
		`SELECT g.*, p.name AS project_name, p.slug AS project_slug,
		        ${HISTORY_AGG_SQL} AS history
		 FROM goals g
		 JOIN projects p ON p.id = g.project_id
		 WHERE g.project_id = $1 ${where}
		 ORDER BY g.archived_at IS NOT NULL, g.created_at ASC`,
		[projectId],
	);
	return r.rows;
}

export async function getGoal(
	db: PGlite,
	projectId: string,
	goalId: string,
): Promise<GoalWithProject | null> {
	const r = await db.query<GoalWithProject>(
		`SELECT g.*, p.name AS project_name, p.slug AS project_slug,
		        ${HISTORY_AGG_SQL} AS history
		 FROM goals g
		 JOIN projects p ON p.id = g.project_id
		 WHERE g.id = $1 AND g.project_id = $2`,
		[goalId, projectId],
	);
	return r.rows[0] ?? null;
}

/** Full, un-capped progress series for a goal — for the larger detail/page chart. */
export async function getGoalHistory(
	db: PGlite,
	projectId: string,
	goalId: string,
): Promise<{ t: string; percent: number; health: GoalHealth }[] | null> {
	const exists = await db.query(`SELECT 1 FROM goals WHERE id = $1 AND project_id = $2`, [
		goalId,
		projectId,
	]);
	if (exists.rows.length === 0) return null;
	const r = await db.query<{ t: string; percent: number; health: GoalHealth }>(
		`SELECT created_at AS t, progress_percent AS percent, health
		 FROM goal_run_updates WHERE goal_id = $1 ORDER BY created_at ASC`,
		[goalId],
	);
	return r.rows;
}

/**
 * Goals in a project that are due for a Captain check: active (not archived) and either
 * never checked or last checked longer ago than their cadence. Mirrors the interval-elapsed
 * test the heartbeat scheduler uses for agents.
 */
export async function getDueGoals(db: PGlite, projectId: string): Promise<GoalRow[]> {
	const r = await db.query<GoalRow>(
		`SELECT ${GOAL_COLUMNS_BARE} FROM goals g
		 WHERE g.project_id = $1
		   AND g.archived_at IS NULL
		   AND (
		     g.last_checked_at IS NULL
		     OR g.last_checked_at + (CASE g.check_frequency
		          WHEN 'daily'   THEN interval '1 day'
		          WHEN 'weekly'  THEN interval '7 days'
		          WHEN 'monthly' THEN interval '1 month'
		        END) < now()
		   )
		 ORDER BY g.created_at ASC`,
		[projectId],
	);
	return r.rows;
}

/**
 * Record one goal's progress snapshot from a goal-check run: update the live goal and append a
 * history row keyed to the run. `runId` is the goal-check run; the (run_id, goal_id) link is
 * what the Goals page reads to annotate "this run updated goals X, Y".
 */
export async function recordGoalProgress(
	db: PGlite,
	input: {
		goalId: string;
		runId: string;
		progressPercent: number;
		health: GoalHealth;
		statusBlurb: string;
	},
	wsManager: WebSocketManager | undefined,
): Promise<GoalRow> {
	const pct = Math.round(input.progressPercent);
	if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
		throw new GoalError('INVALID_REQUEST', 'progress_percent must be between 0 and 100');
	}
	if (input.health === Health.Pending) {
		throw new GoalError('INVALID_REQUEST', 'health must be on_track, at_risk, or off_track');
	}

	const goal = await withTransaction(db, async () => {
		const upd = await db.query<GoalRow>(
			`UPDATE goals
			 SET progress_percent = $1, health = $2::goal_health, status_blurb = $3,
			     last_checked_at = now(), updated_at = now()
			 WHERE id = $4
			 RETURNING ${GOAL_COLUMNS_BARE}`,
			[pct, input.health, input.statusBlurb, input.goalId],
		);
		if (upd.rows.length === 0) {
			throw new GoalError('NOT_FOUND', 'Goal not found');
		}
		await db.query(
			`INSERT INTO goal_run_updates (run_id, goal_id, progress_percent, health, status_blurb)
			 VALUES ($1, $2, $3, $4::goal_health, $5)
			 ON CONFLICT (run_id, goal_id) DO UPDATE
			   SET progress_percent = EXCLUDED.progress_percent,
			       health = EXCLUDED.health,
			       status_blurb = EXCLUDED.status_blurb`,
			[input.runId, input.goalId, pct, input.health, input.statusBlurb],
		);
		return upd.rows[0];
	});

	broadcastRowChange(wsManager, wsRoom.team(goal.team_id as string), 'goals', 'UPDATE', goal);
	return goal;
}

/**
 * The goal-check runs for a project, newest first, each annotated with the titles of the goals
 * it updated. Shown at the bottom of the Goals page.
 */
export async function listGoalCheckRuns(
	db: PGlite,
	projectId: string,
	limit = 50,
): Promise<GoalCheckRunSummary[]> {
	// Goal-check runs are team-scoped (Captain runs with no task); a project maps 1:1 to its
	// team, so filter by the project's team. The title list is a correlated subquery — no join
	// fan-out, no GROUP BY.
	const r = await db.query<GoalCheckRunSummary>(
		`SELECT hr.id, hr.status, hr.created_at, hr.started_at, hr.finished_at,
		        COALESCE((
		          SELECT json_agg(g.title ORDER BY g.title)
		          FROM goal_run_updates gru
		          JOIN goals g ON g.id = gru.goal_id
		          WHERE gru.run_id = hr.id
		        ), '[]'::json) AS updated_goal_titles
		 FROM heartbeat_runs hr
		 WHERE hr.kind = $1
		   AND hr.task_id IS NULL
		   AND hr.team_id = (SELECT team_id FROM projects WHERE id = $2)
		 ORDER BY hr.created_at DESC
		 LIMIT $3`,
		[HeartbeatRunKind.GoalCheck, projectId, limit],
	);
	return r.rows;
}
