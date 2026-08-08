import { type ProgressActivity, type ProjectProgress, wsRoom } from '@hezo/shared';
import type { Db } from '../db/database';
import { broadcastRowChange } from '../lib/broadcast';
import { readProgressActivity } from './project-activity';
import type { WebSocketManager } from './ws';

export class ProjectProgressError extends Error {
	readonly code: 'NOT_FOUND' | 'FORBIDDEN';
	constructor(code: 'NOT_FOUND' | 'FORBIDDEN', message: string) {
		super(message);
		this.code = code;
		this.name = 'ProjectProgressError';
	}
}

/**
 * The Captain-maintained progress shown on the Progress page: the high-level summary plus the
 * three recent-activity columns. Both live on the project row and are written together, so this
 * is one read with no join — the snapshot captured each task's identifier and title at write time.
 */
export async function getProjectProgress(
	db: Db,
	projectId: string,
): Promise<ProjectProgress | null> {
	const r = await db.query<{ summary: string; activity: unknown; updated_at: string | null }>(
		`SELECT progress_summary AS summary,
		        progress_activity AS activity,
		        progress_summary_updated_at AS updated_at
		 FROM projects WHERE id = $1`,
		[projectId],
	);
	const row = r.rows[0];
	if (!row) return null;
	return {
		summary: row.summary,
		activity: readProgressActivity(row.activity),
		updated_at: row.updated_at,
	};
}

/**
 * Replace a project's progress summary and its activity snapshot (Captain, during progress-update
 * runs). Rejected for HQ/internal projects, which have no Progress page. Broadcasts a projects
 * UPDATE so open Progress pages refresh.
 *
 * Summary and snapshot are written in a **single statement** rather than a transaction across
 * two: they are one artifact from one run, so they cannot be observed half-updated and they share
 * `progress_summary_updated_at`. Passing `activity` as undefined leaves the existing snapshot in
 * place, so a caller refreshing only the summary never blanks the columns.
 */
export async function updateProjectProgress(
	db: Db,
	teamId: string,
	projectId: string,
	summary: string,
	wsManager: WebSocketManager | undefined,
	activity?: ProgressActivity,
): Promise<ProjectProgress> {
	const proj = await db.query<{ is_internal: boolean }>(
		`SELECT is_internal FROM projects WHERE id = $1 AND team_id = $2`,
		[projectId, teamId],
	);
	if (proj.rows.length === 0) {
		throw new ProjectProgressError('NOT_FOUND', 'Project not found');
	}
	if (proj.rows[0].is_internal) {
		throw new ProjectProgressError('FORBIDDEN', 'The HQ project has no progress summary');
	}

	const r = await db.query<{
		id: string;
		summary: string;
		activity: unknown;
		updated_at: string;
	}>(
		`UPDATE projects
		 SET progress_summary = $1,
		     progress_activity = COALESCE($3::jsonb, progress_activity),
		     progress_summary_updated_at = now(),
		     updated_at = now()
		 WHERE id = $2
		 RETURNING id, progress_summary AS summary, progress_activity AS activity,
		           progress_summary_updated_at AS updated_at`,
		[summary, projectId, activity ? JSON.stringify(activity) : null],
	);
	const updated = r.rows[0];
	broadcastRowChange(wsManager, wsRoom.team(teamId), 'projects', 'UPDATE', {
		id: updated.id,
		progress_summary: updated.summary,
		progress_summary_updated_at: updated.updated_at,
	});
	return {
		summary: updated.summary,
		activity: readProgressActivity(updated.activity),
		updated_at: updated.updated_at,
	};
}
