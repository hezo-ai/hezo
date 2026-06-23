import type { PGlite } from '@electric-sql/pglite';
import { type ChangeAction, WsMessageType, wsRoom } from '@hezo/shared';
import type { Context } from 'hono';
import type { WebSocketManager } from '../services/ws';
import type { Env } from './types';

export type { ChangeAction };

export function broadcastRowChange(
	wsManager: WebSocketManager | undefined,
	room: string,
	table: string,
	action: ChangeAction,
	row: Record<string, unknown>,
): void {
	if (!wsManager) return;
	wsManager.broadcast(room, { type: WsMessageType.RowChange, table, action, row });
}

export function broadcastChange(
	c: Context<Env>,
	room: string,
	table: string,
	action: ChangeAction,
	row: Record<string, unknown>,
): void {
	broadcastRowChange(c.get('wsManager'), room, table, action, row);
}

/**
 * Broadcast a comment-family row (`task_comments`, `comment_reactions`,
 * `comment_attachments`) enriched with `project_id`.
 *
 * These tables have no `team_id`/`project_id` column, but the web client's
 * realtime subscriber (`useShellWebSockets`) resolves the project slug it
 * invalidates on from `row.project_id` (falling back to `row.team_id`). The
 * team fallback excludes `is_internal` projects, so a bare row — or one keyed
 * only by `team_id` — never resolves for HQ tasks. Injecting `project_id`
 * (resolved with no internal-project filter) makes the change render live for
 * internal and ordinary projects alike. `teamId` still selects the WS room.
 */
export function broadcastCommentFamilyChange(
	wsManager: WebSocketManager | undefined,
	teamId: string,
	projectId: string,
	table: string,
	action: ChangeAction,
	row: Record<string, unknown>,
): void {
	broadcastRowChange(wsManager, wsRoom.team(teamId), table, action, {
		...row,
		project_id: projectId,
	});
}

export function broadcastEvent(
	wsManager: WebSocketManager,
	room: string,
	type: string,
	data: Record<string, unknown>,
): void {
	wsManager.broadcast(room, { type, ...data });
}

export async function broadcastProjectUpdate(
	db: PGlite,
	wsManager: WebSocketManager | undefined,
	teamId: string,
	projectId: string,
): Promise<void> {
	if (!wsManager) return;
	const updated = await db.query<Record<string, unknown>>('SELECT * FROM projects WHERE id = $1', [
		projectId,
	]);
	const row = updated.rows[0];
	if (!row) return;
	broadcastRowChange(wsManager, wsRoom.team(teamId), 'projects', 'UPDATE', row);
}
