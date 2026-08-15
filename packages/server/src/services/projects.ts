import { type ProjectProgress, wsRoom } from '@hezo/shared';
import type { Db } from '../db/database';
import { broadcastRowChange } from '../lib/broadcast';
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
 * The Captain-maintained progress summary shown at the top of the project dashboard. It lives on
 * the project row, so this is one read with no join.
 */
export async function getProjectProgress(
	db: Db,
	projectId: string,
): Promise<ProjectProgress | null> {
	const r = await db.query<{ summary: string; updated_at: string | null }>(
		`SELECT progress_summary AS summary,
		        progress_summary_updated_at AS updated_at
		 FROM projects WHERE id = $1`,
		[projectId],
	);
	const row = r.rows[0];
	if (!row) return null;
	return { summary: row.summary, updated_at: row.updated_at };
}

/**
 * Replace a project's progress summary (Captain, during progress-update runs). Rejected for
 * HQ/internal projects, which have no progress summary. Broadcasts a projects UPDATE so open
 * dashboards refresh.
 */
export async function updateProjectProgress(
	db: Db,
	teamId: string,
	projectId: string,
	summary: string,
	wsManager: WebSocketManager | undefined,
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
		updated_at: string;
	}>(
		`UPDATE projects
		 SET progress_summary = $1,
		     progress_summary_updated_at = now(),
		     updated_at = now()
		 WHERE id = $2
		 RETURNING id, progress_summary AS summary,
		           progress_summary_updated_at AS updated_at`,
		[summary, projectId],
	);
	const updated = r.rows[0];
	broadcastRowChange(wsManager, wsRoom.team(teamId), 'projects', 'UPDATE', {
		id: updated.id,
		progress_summary: updated.summary,
		progress_summary_updated_at: updated.updated_at,
	});
	return { summary: updated.summary, updated_at: updated.updated_at };
}
