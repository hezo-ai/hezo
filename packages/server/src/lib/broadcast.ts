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
	companyId: string,
	projectId: string,
): Promise<void> {
	if (!wsManager) return;
	const updated = await db.query<Record<string, unknown>>('SELECT * FROM projects WHERE id = $1', [
		projectId,
	]);
	const row = updated.rows[0];
	if (!row) return;
	broadcastRowChange(wsManager, wsRoom.company(companyId), 'projects', 'UPDATE', row);
}
