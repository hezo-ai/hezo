import type { Context } from 'hono';
import type { WebSocketManager } from '../services/ws';
import type { Env } from './types';

export type ChangeAction = 'INSERT' | 'UPDATE' | 'DELETE';

export function broadcastChange(
	c: Context<Env>,
	room: string,
	table: string,
	action: ChangeAction,
	row: Record<string, unknown>,
): void {
	const ws = c.get('wsManager');
	ws.broadcast(room, { type: 'row_change', table, action, row });
}

export function broadcastEvent(
	wsManager: WebSocketManager,
	room: string,
	type: string,
	data: Record<string, unknown>,
): void {
	wsManager.broadcast(room, { type, ...data });
}
