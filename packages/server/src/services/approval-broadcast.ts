import type { ChangeAction } from '@hezo/shared';
import { wsRoom } from '@hezo/shared';
import { broadcastRowChange } from '../lib/broadcast';
import type { WebSocketManager } from './ws';

export function broadcastApprovalChange(
	wsManager: WebSocketManager | undefined,
	teamId: string,
	action: ChangeAction,
	row: Record<string, unknown>,
): void {
	if (!wsManager) return;
	const payload = row.team_id != null ? row : { ...row, team_id: teamId };
	broadcastRowChange(wsManager, wsRoom.team(teamId), 'approvals', action, payload);
}
